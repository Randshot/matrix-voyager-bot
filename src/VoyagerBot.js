var CommandProcessor = require("./matrix/CommandProcessor");
var LocalStorage = require("node-localstorage").LocalStorage;
var config = require("config");
var log = require("./LogService");
var naturalSort = require("node-natural-sort");
var MatrixClientLite = require("./matrix/MatrixClientLite");
var _ = require("lodash");
var Promise = require('bluebird');
var moment = require('moment');

const STATS_CACHE_MS = 1 * 60 * 60 * 1000; // 1 hour

/**
 * The main entry point for the bot. Handles most of the business logic and bot actions
 */
class VoyagerBot {

    /**
     * Creates a new VoyagerBot
     * @param {VoyagerStore} store the store to use
     */
    constructor(store) {
        this._localStorage = new LocalStorage("db/voyager_local_storage", 100 * 1024 * 1024); // quota is 100mb

        this._nodeUpdateQueue = [];
        this._processingNodes = false;
        this._queuedObjectIds = [];
        this._queueNodesForUpdate = config.get('bot.processNodeUpdatesOnStartup');
        this._queueUsersOnStartup = config.get('bot.nodeUpdatesOnStartup.users');
        this._queueRoomsOnStartup = config.get('bot.nodeUpdatesOnStartup.rooms');

        this._store = store;
        this._commandProcessor = new CommandProcessor(this, store);
        this._statsCache = {};

        this._client = new MatrixClientLite(config['matrix']['homeserverUrl'], config['matrix']['accessToken'], config['matrix']['userId']);

        this._loadPendingNodeUpdates();

        this._client.on('room_invite', this._onInvite.bind(this));
        this._client.on('room_message', this._onRoomMessage.bind(this));
        this._client.on('room_leave', this._onRoomLeave.bind(this));
        this._client.on('room_avatar', this._onRoomUpdated.bind(this));
        this._client.on('room_name', this._onRoomUpdated.bind(this));
        this._client.on('room_join_rules', this._onRoomUpdated.bind(this));
        this._client.on('room_aliases', this._onRoomUpdated.bind(this));
        this._client.on('room_canonical_alias', this._onRoomUpdated.bind(this));
        this._client.on('user_avatar', this._onUserUpdated.bind(this));
        this._client.on('user_name', this._onUserUpdated.bind(this));
    }

    /**
     * Starts the voyager bot
     */
    start() {
        this._client.start().then(() => {
            log.info("VoyagerBot", "Enabling node updates now that the bot is syncing");
            this._queueNodesForUpdate = true;

            this._tryUpdateNodeVersions();

            this._processNodeVersions();
            setInterval(() => this._processNodeVersions(), 15000);
        });
    }

    _onRoomUpdated(roomId, event) {
        this._queueNodeUpdate({objectId: roomId, type: 'room'});
    }

    _onUserUpdated(roomId, event) {
        this._queueNodeUpdate({objectId: event['sender'], inRoom: roomId, type: 'user'});
    }

    _onRoomMessage(roomId, event) {
        if (event['sender'] === this._client.selfId) return; // self - ignore

        var body = event['content']['body'];
        if (!body) return; // likely redacted

        if (body.startsWith("!voyager")) {
            this._commandProcessor.processCommand(roomId, event, body.substring("!voyager".length).trim().split(" ")).catch(err => {
                log.error("VoyagerBot", "Error processing command " + body);
                log.error("VoyagerBot", err);
                this._commandProcessor._reply(roomId, event, "There was an error processing your command"); // HACK: Should not be calling private methods
            });
            return;
        }

        this._store.isDnt(event['sender']).then(dnt => {
            if (dnt) {
                log.warn("VoyagerBot", "Received message from " + event['sender'] + " but the user has set DNT. Ignoring message.");
                return;
            } //else log.silly("VoyagerBot", "User " + event['sender'] + " does not have DNT");

            var matches = body.match(/[#!][a-zA-Z0-9.\-_#=]+:[a-zA-Z0-9.\-_]+[a-zA-Z0-9]/g);
            if (!matches) return;

            var promise = Promise.resolve();
            _.forEach(matches, match => promise = promise.then(() => this._processMatchedLink(roomId, event, match)));

            promise.then(() => this._client.sendReadReceipt(roomId, event['event_id']));
        });
    }

    _onRoomLeave(roomId, event) {
        if (event['state_key'] === this._client.selfId) {
            if (event['sender'] === this._client.selfId) {
                // Probably admin action or we soft kicked.
                // TODO: If not already a soft kick, record as soft kick (#130)
            } else if (event['content']['membership'] === 'ban') {
                this._onBan(roomId, event);
            } else if (event['unsigned']['prev_content'] && event['unsigned']['prev_content']['membership'] === 'ban') {
                // TODO: Handled unbanned state?
                log.info("VoyagerBot", event['sender'] + " has unbanned the bot in " + roomId);
            } else this._onKick(roomId, event);
        }
    }

    _processMatchedLink(inRoomId, event, matchedValue, retryCount = 0) {
        var roomId;
        var sourceNode;
        var targetNode;

        return this._client.joinRoom(matchedValue).then(rid => {
            roomId = rid;
            return this.getNode(roomId, 'room');
        }, err => {
            if (err.httpStatus == 500 && retryCount < 5) {
                return this._processMatchedLink(event, matchedValue, ++retryCount);
            }

            log.error("VoyagerBot", err);
            return Promise.resolve(); // TODO: Record failed event as unlinkable node
        }).then(node => {
            if (!roomId) return Promise.resolve();
            targetNode = node;

            return this.getNode(inRoomId, 'room');
        }).then(node => {
            if (!roomId) return Promise.resolve();
            sourceNode = node;
            return this._store.createLink(sourceNode, targetNode, 'message', event['origin_server_ts']);
        }).then(link => {
            if (!link) return Promise.resolve();
            return this._store.createTimelineEvent(link, event['origin_server_ts'], event['event_id'], 'Matched: ' + matchedValue);
        });
    }

    _onInvite(roomId, event) {
        var sourceNode;
        var targetNode;

        if (event.__voyagerRepeat) {
            log.info("VoyagerBot", "Attempt #" + event.__voyagerRepeat + " to retry event " + event['event_id']);
        }

        return this._client.joinRoom(roomId)
            .then(() => Promise.all([this.getNode(event['sender'], 'user'), this.getNode(roomId, 'room')]))
            .then(nodes => {
                sourceNode = nodes[0];
                targetNode = nodes[1];
                return this._store.findLinkByTimeline(sourceNode, targetNode, 'invite', event['event_id'])
            })
            .then(existingLink => {
                if (existingLink) return Promise.resolve();
                else return this._store.createLink(sourceNode, targetNode, 'invite', event['origin_server_ts'])
                    .then(link => this._store.createTimelineEvent(link, event['origin_server_ts'], event['event_id']));
            })
            .then(() => this._tryUpdateRoomNodeVersion(roomId))
            .catch(err => {
                log.error("VoyagerBot", err);

                // Sometimes the error is nested under another object
                if (err['body']) err = err['body'];

                // Convert the error to an object if we can
                if (typeof(err) === 'string') {
                    try {
                        err = JSON.parse(err);
                    } catch (e) {
                    }
                }

                if ((err['errcode'] == "M_FORBIDDEN" || err['errcode'] == "M_GUEST_ACCESS_FORBIDDEN") && (!event.__voyagerRepeat || event.__voyagerRepeat < 25)) { // 25 is arbitrary
                    event.__voyagerRepeat = (event.__voyagerRepeat ? event.__voyagerRepeat : 0) + 1;
                    log.info("VoyagerBot", "Forbidden as part of event " + event['event_id'] + " - will retry for attempt #" + event.__voyagerRepeat + " shortly.");
                    setTimeout(() => this._onInvite(roomId, event), 1000); // try again later
                } else if (event.__voyagerRepeat) {
                    log.error("VoyagerBot", "Failed to retry event " + event['event_id']);
                }
            });
    }

    _onKick(roomId, event) {
        return this._addKickBan(roomId, event, 'kick');
    }

    _onBan(roomId, event) {
        return this._addKickBan(roomId, event, 'ban');
    }

    _addKickBan(roomId, event, type) {
        var roomNode;
        var userNode;
        var kickbanLink;

        log.info("VoyagerBot", "Recording " + type + " for " + roomId + " made by " + event['sender']);

        return this.getNode(event['sender'], 'user').then(node => {
            userNode = node;
            return this.getNode(roomId, 'room');
        }).then(node => {
            roomNode = node;
            return this._store.redactNode(roomNode);
        }).then(() => {
            return this._store.createLink(userNode, roomNode, type, event['origin_server_ts'], false, true);
        }).then(link => {
            kickbanLink = link;
            var reason = (event['content'] || {})['reason'] || null;
            return this._store.createTimelineEvent(kickbanLink, event['origin_server_ts'], event['event_id'], reason);
        });
    }

    getNode(objectId, type) {
        return this._store.getNode(type, objectId).then(node => {
            if (node) return Promise.resolve(node);

            if (type == 'user')
                return this._createUserNode(objectId);
            else if (type == 'room')
                return this._createRoomNode(objectId);
            else throw new Error("Unexpected node type: " + type);
        });
    }

    _createUserNode(userId) {
        return this._getUserVersion(userId).then(version => this._store.createNode('user', userId, version));
    }

    _createRoomNode(roomId) {
        return this._getRoomVersion(roomId).then(version => this._store.createNode('room', roomId, version, version.aliases));
    }

    _getUserVersion(userId) {
        var version = {
            displayName: "",
            avatarUrl: "",
            isAnonymous: !this._store.isEnrolled(userId),
            primaryAlias: null, // users can't have aliases
        };

        // Don't get profile information if the user isn't public
        if (version.isAnonymous) {
            return Promise.resolve(version);
        }

        return this._client.getUserInfo(userId).then(userInfo => {
            version.displayName = userInfo['displayname'];
            version.avatarUrl = userInfo['avatar_url'];

            if (!version.avatarUrl || version.avatarUrl.trim().length == 0)
                version.avatarUrl = null;
            else version.avatarUrl = this._client.convertMediaToThumbnail(version.avatarUrl, 256, 256);

            if (!version.displayName || version.displayName.trim().length == 0)
                version.displayName = null;

            return version;
        });
    }

    _getRoomVersion(roomId) {
        var version = {
            displayName: null,
            avatarUrl: null,
            isAnonymous: true,
            primaryAlias: null,
            aliases: [],
            stats: {users: 0, servers: 0} // aliases handled by above array
        };

        return this._client.getRoomState(roomId).then(state => {
            var roomMembers = []; // displayNames (strings)
            var joinedMembers = []; // same as room members
            var matrixDotOrgAliases = []; // special case handling
            var servers = [];

            var tryAddServer = (component) => {
                var serverParts = component.split(':');
                var server = serverParts[serverParts.length - 1];
                if (servers.indexOf(server) == -1)
                    servers.push(server);
            };

            var chain = Promise.resolve();
            state.map(event => chain = chain.then(() => {
                if (event['type'] === 'm.room.join_rules') {
                    log.silly("VoyagerBot", "m.room.join_rules for " + roomId + " is " + event['content']['join_rule']);
                    version.isAnonymous = event['content']['join_rule'] !== 'public';
                } else if (event['type'] === 'm.room.member') {
                    if (event['user_id'] === this._client.selfId) return; // skip ourselves, always
                    log.silly("VoyagerBot", "m.room.member of " + event['user_id'] + " in " + roomId + " is " + event['membership']);

                    var displayName = event['content']['displayname'];
                    if (!displayName || displayName.trim().length === 0)
                        displayName = event['user_id'];

                    roomMembers.push(displayName);
                    if (event['membership'] === 'join' || event['membership'] === 'invite') joinedMembers.push(displayName);
                    tryAddServer(event['user_id']);

                    // Create the node, but don't bother updating the information for it
                    return this.getNode(event['user_id'], 'user').then(n => log.silly("VoyagerBot", "Got node for " + n.objectId + ": " + n.id));
                } else if (event['type'] === 'm.room.aliases') {
                    if (event['content']['aliases']) {
                        log.silly("VoyagerBot", "m.room.aliases for " + roomId + " on domain " + event['state_key'] + " is: " + event['content']['aliases'].join(', '));
                        for (var alias of event['content']['aliases']) {
                            version.aliases.push(alias);
                            if (alias.endsWith(":matrix.org")) matrixDotOrgAliases.push(alias);
                            tryAddServer(alias);
                        }
                    } else log.silly("VoyagerBot", "m.room.aliases for " + roomId + " on domain " + event['state_key'] + " is empty/null");
                } else if (event['type'] === 'm.room.canonical_alias') {
                    log.silly("VoyagerBot", "m.room.canonical_alias for " + roomId + " is " + event['content']['alias']);
                    version.primaryAlias = event['content']['alias'];
                    if (event['content']['alias']) tryAddServer(event['content']['alias']);
                } else if (event['type'] === 'm.room.name') {
                    log.silly("VoyagerBot", "m.room.name for " + roomId + " is " + event['content']['name']);
                    version.displayName = event['content']['name'];
                } else if (event['type'] === 'm.room.avatar') {
                    log.silly("VoyagerBot", "m.room.avatar for " + roomId + " is " + event['content']['url']);
                    if (event['content']['url'] && event['content']['url'].trim().length > 0)
                        version.avatarUrl = this._client.convertMediaToThumbnail(event['content']['url'], 256, 256);
                } else log.silly("VoyagerBot", "Not handling state event " + event['type'] + " in room " + roomId);
            }));

            return chain.then(() => {
                // Populate stats
                version.stats.users = joinedMembers.length;
                version.stats.servers = servers.length;

                // HACK: This is technically against spec, but we'll pick a reasonable default for a room's alias if there is none.
                if (!version.primaryAlias && version.aliases.length > 0)
                    version.primaryAlias = (matrixDotOrgAliases.length > 0 ? matrixDotOrgAliases[0] : version.aliases[0]);

                // Now that we've processed room state: determine the room name
                if (version.displayName && version.displayName.trim().length > 0) return version; // we're done :)

                matrixDotOrgAliases.sort();
                version.aliases.sort();
                joinedMembers.sort(naturalSort({caseSensitive: false}));
                roomMembers.sort(naturalSort({caseSensitive: false}));

                // Display name logic (according to matrix spec) | http://matrix.org/docs/spec/client_server/r0.2.0.html#id222
                // 1. Use m.room.name (handled above)
                // 2. Use m.room.canonical_alias
                //   a. *Against Spec* Use m.room.aliases, picking matrix.org aliases over other aliases, if no canonical alias
                // 3. Use joined/invited room members (not including self)
                //    a. 1 member - use their display name
                //    b. 2 members - use their display names, lexically sorted
                //    c. 3+ members - use first display name, lexically, and show 'and N others'
                // 4. Consider left users and repeat #3 ("Empty room (was Alice and Bob)")
                // 5. Show 'Empty Room' - this shouldn't happen as it is an error condition in the spec

                // using canonical alias
                if (version.primaryAlias && version.primaryAlias.trim().length > 0) {
                    version.displayName = version.primaryAlias;
                    return version;
                }

                // using other aliases, against spec, preferring matrix.org
                if (version.aliases.length > 0) {
                    if (matrixDotOrgAliases.length > 0) {
                        version.displayName = matrixDotOrgAliases[0];
                    } else version.displayName = version.aliases[0];
                    return version;
                }

                // pick the appropriate collection of members
                var memberArray = joinedMembers;
                if (memberArray.length === 0) memberArray = roomMembers;

                // build a room name using those members
                if (memberArray.length === 1) {
                    version.displayName = memberArray[0];
                    return version;
                } else if (memberArray.length === 2) {
                    version.displayName = memberArray[0] + " and " + memberArray[1];
                    return version;
                } else if (memberArray.length > 2) {
                    version.displayName = memberArray[0] + " and " + (memberArray.length - 1) + " others";
                    return version;
                }

                // weird fallback scenario (alone in room)
                version.displayName = "Empty Room";

                return version;
            });
        });
    }

    getRoomStateEvents(roomId, type, stateKey) {
        return this._client.getRoomStateEvents(roomId, type, stateKey);
    }

    sendNotice(roomId, message) {
        return this._client.sendNotice(roomId, message);
    }

    leaveRoom(roomId) {
        return this._client.leaveRoom(roomId);
    }

    matchRoomSharedWith(roomIdOrAlias, userId) {
        return this._client.getJoinedRooms().then(joinedRooms => {
            var promiseChain = Promise.resolve();
            _.forEach(joinedRooms, roomId => {
                promiseChain = promiseChain
                    .then(() => this._client.getRoomState(roomId))
                    .then(state => {
                        var isMatch = roomIdOrAlias === roomId;
                        var isMember = false;

                        for (var event of state) {
                            if (event['type'] === 'm.room.canonical_alias' && event['content']['alias'] === roomIdOrAlias) {
                                isMatch = true;
                            } else if (event['type'] === 'm.room.aliases' && event['content']['aliases'].indexOf(roomIdOrAlias) !== -1) {
                                isMatch = true;
                            } else if (event['type'] === 'm.room.member' && event['user_id'] === userId && event['membership'] === 'join') {
                                isMember = true;
                            }

                            if (isMatch && isMember) break; // to save a couple clock cycles
                        }

                        if (isMatch && isMember) return Promise.reject(roomId); // reject === break loop
                        else return Promise.resolve(); // resolve === try next room
                    });
            });

            // Invert the success and fail because of how the promise chain is dealt with
            return promiseChain.then(() => Promise.resolve(null), roomId => Promise.resolve(roomId));
        });
    }

    _queueNodeUpdate(nodeMeta, doSave = true) {
        if (!nodeMeta.objectId) {
            log.warn("VoyagerBot", "Unexpected node: " + JSON.stringify(nodeMeta));
            return;
        }

        //if (nodeMeta.type === 'user') {
        //    log.warn("VoyagerBot", "Skipping user node update for " + nodeMeta.objectId);
        //    return;
        //}

        if (this._queuedObjectIds.indexOf(nodeMeta.objectId) !== -1) {
            log.info("VoyagerBot", "Node update queue attempt for " + nodeMeta.objectId + " - skipped because the node is already queued");
            return;
        }

        this._nodeUpdateQueue.push(nodeMeta);
        this._queuedObjectIds.push(nodeMeta.objectId);
        if (doSave) this._savePendingNodeUpdates();

        log.info("VoyagerBot", "Queued update for " + nodeMeta.objectId);
    }

    _savePendingNodeUpdates() {
        log.info("VoyagerBot", "Saving queued node updates");
        this._localStorage.setItem("voyager_node_update_queue", JSON.stringify(this._nodeUpdateQueue));
    }

    _loadPendingNodeUpdates() {
        var pendingNodeUpdates = this._localStorage.getItem("voyager_node_update_queue");
        if (pendingNodeUpdates) {
            var nodeUpdatesAsArray = JSON.parse(pendingNodeUpdates);
            for (var update of nodeUpdatesAsArray) {
                update.retryCount = 0;
                if (update.node && !update.objectId) {
                    update.objectId = update.node;
                    update.node = null;
                }
                this._queueNodeUpdate(update, /*doSave:*/false);
            }
        }
        log.info("VoyagerBot", "Loaded " + this._nodeUpdateQueue.length + " previously pending node updates");
    }

    _processNodeVersions() {
        if (this._processingNodes) {
            log.warn("VoyagerBot", "Already processing nodes from queue - skipping interval check");
            return;
        }

        this._processingNodes = true;
        var nodesToProcess = this._nodeUpdateQueue.splice(0, 2500);
        this._savePendingNodeUpdates();

        log.info("VoyagerBot", "Processing " + nodesToProcess.length + " pending node updates. " + this._nodeUpdateQueue.length + " remaining");

        var promiseChain = Promise.resolve();
        _.forEach(nodesToProcess, node => {
            promiseChain = promiseChain.then(() => {
                var idx = this._queuedObjectIds.indexOf(node.objectId);
                if (idx !== -1) this._queuedObjectIds.splice(idx, 1);

                var promise = Promise.resolve();

                try {
                    switch (node.type) {
                        case "room":
                            promise = this._tryUpdateRoomNodeVersion(node.objectId);
                            break;
                        case "user":
                            promise = this._tryUpdateUserNodeVersion(node.objectId);
                            break;
                        default:
                            log.warn("VoyagerBot", "Could not handle node in update queue: " + JSON.stringify(node));
                            return Promise.resolve();
                    }
                } catch (error) {
                    promise = Promise.reject(error);
                }

                return promise.then(() => log.info("VoyagerBot", "Completed update for " + node.objectId)).catch(err => {
                    log.error("VoyagerBot", "Error updating node " + node.objectId);
                    log.error("VoyagerBot", err);

                    if (node.retryCount >= 5) {
                        log.error("VoyagerBot", "Not retrying node update for node " + node.objectId + " due to the maximum number of retries reached (5)");
                        return;
                    }

                    if (!node.retryCount) node.retryCount = 0;
                    node.retryCount++;

                    log.warn("VoyagerBot", "Re-queueing node " + node.objectId + " for updates due to failure. This will be retry #" + node.retryCount);

                    this._queueNodeUpdate(node);
                });
            });
        });

        promiseChain.then(() => {
            log.info("VoyagerBot", "Processed " + nodesToProcess.length + " node updates. " + this._nodeUpdateQueue.length + " remaining");
            this._processingNodes = false;
        }).catch(err => {
            log.info("VoyagerBot", "Processed " + nodesToProcess.length + " node updates (with errors). " + this._nodeUpdateQueue.length + " remaining");
            log.error("VoyagerBot", err);
            this._processingNodes = false;
        });
    }

    _tryUpdateNodeVersions() {
        if (!this._queueNodesForUpdate) {
            log.verbose("VoyagerBot", "Skipping state updates for all nodes - node updates are disabled");
            return;
        }

        var promises = [];

        if (this._queueRoomsOnStartup) {
            promises.push(this._client.getJoinedRooms().then(joinedRooms => {
                _.forEach(joinedRooms, roomId => this._queueNodeUpdate({
                    objectId: roomId,
                    type: 'room'
                }, /*saveQueue:*/false));
            }).catch(err => {
                log.warn("VoyagerBot", "Failed to update rooms from startup: Matrix error.");
            }));
        }

        if (this._queueUsersOnStartup) {
            promises.push(this._store.getNodesByType('user').then(users => {
                _.forEach(users, user => this._queueNodeUpdate({
                    objectId: user.objectId,
                    type: 'user'
                }, /*saveQueue:*/false));
            }));
        }

        Promise.all(promises).then(() => this._savePendingNodeUpdates());
    }

    _tryUpdateUserNodeVersion(userId) {
        if (!userId) {
            log.warn("VoyagerBot", "Try update user node failed: User ID was null");
            return Promise.resolve();
        }
        log.info("VoyagerBot", "Attempting an update for user node: " + userId);

        var userNode;
        var userMeta;

        // We won't bother updating the user information, just create the user
        return this.getNode(userId, 'user');

        //return this.getNode(userId, 'user').then(node => {
        //    userNode = node;

        //    return this._store.getCurrentNodeState(userNode);
        //}).then(meta=> {
        //    userMeta = meta;
        //    return this._getUserVersion(userId);
        //}).then(realVersion => {
        //    return this._tryUpdateNodeVersion(userNode, userMeta, realVersion);
        //});
    }

    _tryUpdateRoomNodeVersion(roomId) {
        if (!roomId) {
            log.warn("VoyagerBot", "Try update room node failed: Room ID was null");
            return Promise.resolve();
        }
        log.info("VoyagerBot", "Attempting an update for room node: " + roomId);

        var roomNode;
        var roomMeta;
        var roomAliases;

        return this.getNode(roomId, 'room').then(node => {
            roomNode = node;

            return this._store.getCurrentNodeState(roomNode);
        }).then(meta => {
            roomMeta = meta;

            return this._store.getNodeAliases(roomNode);
        }).then(aliases => {
            roomAliases = aliases || [];
            return this._getRoomVersion(roomId);
        }).then(realVersion => {
            return this._tryUpdateNodeVersion(roomNode, roomMeta, realVersion, roomAliases);
        });
    }

    _replaceNulls(obj, defs) {
        for (var key in obj) {
            if (obj[key] === null || obj[key] === undefined) {
                if (defs[key] !== null && defs[key] !== undefined) {
                    obj[key] = defs[key];
                }
            }
        }
    }

    _tryUpdateNodeVersion(node, meta, currentVersion, storedAliases) {
        var newVersion = {};
        var updated = false;
        var aliasesUpdated = false;

        var defaults = {
            displayName: '',
            avatarUrl: '',
            isAnonymous: true,
            primaryAlias: ''
        };

        // Ensure that `null != ''` doesn't end up triggering an update
        this._replaceNulls(meta, defaults);
        this._replaceNulls(currentVersion, defaults);

        if (currentVersion.displayName != meta.displayName) {
            newVersion.displayName = currentVersion.displayName || '';
            updated = true;
        }
        if (currentVersion.avatarUrl != meta.avatarUrl) {
            newVersion.avatarUrl = currentVersion.avatarUrl || '';
            updated = true;
        }
        if (currentVersion.isAnonymous != meta.isAnonymous) {
            newVersion.isAnonymous = currentVersion.isAnonymous;
            updated = true;
        }
        if (currentVersion.primaryAlias != meta.primaryAlias && node.type == 'room') {
            newVersion.primaryAlias = currentVersion.primaryAlias || '';
            updated = true;
        }

        if (currentVersion.aliases) {
            newVersion.aliasCount = storedAliases.length;
            if (currentVersion.aliases.length != storedAliases.length) {
                aliasesUpdated = true;
            } else {
                for (var newAlias of storedAliases) {
                    if (currentVersion.aliases.indexOf(newAlias.alias) === -1) {
                        aliasesUpdated = true;
                        break;
                    }
                }
            }
        }

        if (node.id == 54)
            console.log(currentVersion);
        newVersion.userCount = (currentVersion.stats ? currentVersion.stats.users : 0);
        newVersion.serverCount = (currentVersion.stats ? currentVersion.stats.servers : 0);

        var statsUpdated =
            meta.userCount != newVersion.userCount
            || meta.aliasCount != newVersion.aliasCount
            || meta.serverCount != newVersion.serverCount;

        var versionPromise = Promise.resolve();
        var aliasPromise = Promise.resolve();

        if (updated || statsUpdated) {
            log.info("VoyagerBot", "Updating meta for node " + node.objectId + " to: " + JSON.stringify(newVersion));

            var oldValues = {};
            for (var key in newVersion) {
                oldValues[key] = meta[key];
            }
            log.info("VoyagerBot", "Old meta for node " + node.objectId + " was (changed properties only): " + JSON.stringify(oldValues));

            versionPromise = this._store.createNodeVersion(node, newVersion);
        }

        if (aliasesUpdated) {
            log.info("VoyagerBot", "Updating aliases for node " + node.objectId + " to " + JSON.stringify(currentVersion.aliases) + " from " + JSON.stringify(storedAliases));
            aliasPromise = this._store.setNodeAliases(node, currentVersion.aliases);
        }

        return Promise.all([versionPromise, aliasPromise]);
    }
}

module.exports = VoyagerBot;
