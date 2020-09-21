'use strict';

const EventEmitter = require('events');
const puppeteer = require('puppeteer');
const moduleRaid = require('@pedroslopez/moduleraid/moduleraid');
const jsQR = require('jsqr');

const Util = require('./util/Util');
const InterfaceController = require('./util/InterfaceController');
const { WhatsWebURL, DefaultOptions, Events, WAState } = require('./util/Constants');
const { ExposeStore, LoadUtils } = require('./util/Injected');
const ChatFactory = require('./factories/ChatFactory');
const ContactFactory = require('./factories/ContactFactory');
const { ClientInfo, Message, MessageMedia, Contact, Location, GroupNotification } = require('./structures');
/**
 * Starting point for interacting with the WhatsApp Web API
 * @extends {EventEmitter}
 * @param {object} options - Client options
 * @param {number} options.authTimeoutMs - Timeout for authentication selector in puppeteer
 * @param {object} options.puppeteer - Puppeteer launch options. View docs here: https://github.com/puppeteer/puppeteer/
 * @param {number} options.qrRefreshIntervalMs - Refresh interval for qr code (how much time to wait before checking if the qr code has changed)
 * @param {number} options.qrTimeoutMs - Timeout for qr code selector in puppeteer
 * @param {string} options.restartOnAuthFail  - Restart client with a new session (i.e. use null 'session' var) if authentication fails
 * @param {object} options.session - Whatsapp session to restore. If not set, will start a new session
 * @param {string} options.session.WABrowserId
 * @param {string} options.session.WASecretBundle
 * @param {string} options.session.WAToken1
 * @param {string} options.session.WAToken2
 * @param {number} options.takeoverOnConflict - If another whatsapp web session is detected (another browser), take over the session in the current browser
 * @param {number} options.takeoverTimeoutMs - How much time to wait before taking over the session
 * @param {string} options.userAgent - User agent to use in puppeteer
 * 
 * @fires Client#qr
 * @fires Client#authenticated
 * @fires Client#auth_failure
 * @fires Client#ready
 * @fires Client#message
 * @fires Client#message_ack
 * @fires Client#message_create
 * @fires Client#message_revoke_me
 * @fires Client#message_revoke_everyone
 * @fires Client#media_uploaded
 * @fires Client#group_join
 * @fires Client#group_leave
 * @fires Client#group_update
 * @fires Client#disconnected
 * @fires Client#change_state
 * @fires Client#change_battery
 */
class Client extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = Util.mergeDefault(DefaultOptions, options);

        this.pupBrowser = null;
        this.pupPage = null;
    }

    /**
     * Sets up events and requirements, kicks off authentication request
     */
    async initialize() {
        const browser = await puppeteer.launch(this.options.puppeteer);
        const page = (await browser.pages())[0];
        page.setUserAgent(this.options.userAgent);

        this.pupBrowser = browser;
        this.pupPage = page;

        if (this.options.session) {
            await page.evaluateOnNewDocument(
                session => {
                    localStorage.clear();
                    localStorage.setItem('WABrowserId', session.WABrowserId);
                    localStorage.setItem('WASecretBundle', session.WASecretBundle);
                    localStorage.setItem('WAToken1', session.WAToken1);
                    localStorage.setItem('WAToken2', session.WAToken2);
                }, this.options.session);
        }

        await page.goto(WhatsWebURL, {
            waitUntil: 'load',
            timeout: 0,
        });

        const KEEP_PHONE_CONNECTED_IMG_SELECTOR = '[data-asset-intro-image-light="true"], [data-asset-intro-image-dark="true"]';

        if (this.options.session) {
            // Check if session restore was successfull 
            try {
                await page.waitForSelector(KEEP_PHONE_CONNECTED_IMG_SELECTOR, { timeout: this.options.authTimeoutMs });
            } catch (err) {
                if (err.name === 'TimeoutError') {
                    /**
                     * Emitted when there has been an error while trying to restore an existing session
                     * @event Client#auth_failure
                     * @param {string} message
                     */
                    this.emit(Events.AUTHENTICATION_FAILURE, 'Unable to log in. Are the session details valid?');
                    browser.close();
                    if (this.options.restartOnAuthFail) {
                        // session restore failed so try again but without session to force new authentication
                        this.options.session = null;
                        this.initialize();
                    }
                    return;
                }

                throw err;
            }

        } else {
            const getQrCode = async () => {
                // Check if retry button is present
                var QR_RETRY_SELECTOR = 'div[data-ref] > span > div';
                var qrRetry = await page.$(QR_RETRY_SELECTOR);
                if (qrRetry) {
                    await qrRetry.click();
                }

                // Wait for QR Code

                const QR_CANVAS_SELECTOR = 'canvas';
                await page.waitForSelector(QR_CANVAS_SELECTOR, { timeout: this.options.qrTimeoutMs });
                const qrImgData = await page.$eval(QR_CANVAS_SELECTOR, canvas => [].slice.call(canvas.getContext('2d').getImageData(0, 0, 264, 264).data));
                const qr = jsQR(qrImgData, 264, 264).data;
                /**
                * Emitted when the QR code is received
                * @event Client#qr
                * @param {string} qr QR Code
                */
                this.emit(Events.QR_RECEIVED, qr);
            };
            getQrCode();
            this._qrRefreshInterval = setInterval(getQrCode, this.options.qrRefreshIntervalMs);

            // Wait for code scan
            await page.waitForSelector(KEEP_PHONE_CONNECTED_IMG_SELECTOR, { timeout: 0 });
            clearInterval(this._qrRefreshInterval);
            this._qrRefreshInterval = undefined;

        }

        await page.evaluate(ExposeStore, moduleRaid.toString());

        // Get session tokens
        const localStorage = JSON.parse(await page.evaluate(() => {
            return JSON.stringify(window.localStorage);
        }));

        const session = {
            WABrowserId: localStorage.WABrowserId,
            WASecretBundle: localStorage.WASecretBundle,
            WAToken1: localStorage.WAToken1,
            WAToken2: localStorage.WAToken2
        };

        /**
         * Emitted when authentication is successful
         * @event Client#authenticated
         * @param {object} session Object containing session information. Can be used to restore the session.
         * @param {string} session.WABrowserId
         * @param {string} session.WASecretBundle
         * @param {string} session.WAToken1
         * @param {string} session.WAToken2
         */
        this.emit(Events.AUTHENTICATED, session);

        // Check window.Store Injection
        await page.waitForFunction('window.Store != undefined');

        //Load util functions (serializers, helper functions)
        await page.evaluate(LoadUtils);

        // Expose client info
        /**
         * Current connection information
         * @type {ClientInfo}
         */
        this.info = new ClientInfo(this, await page.evaluate(() => {
            return window.Store.Conn.serialize();
        }));

        // Add InterfaceController
        this.interface = new InterfaceController(this);

        // Register events
        await page.exposeFunction('onAddMessageEvent', msg => {
            if (!msg.isNewMsg) return;

            if (msg.type === 'gp2') {
                const notification = new GroupNotification(this, msg);
                if (msg.subtype === 'add' || msg.subtype === 'invite') {
                    /**
                     * Emitted when a user joins the chat via invite link or is added by an admin.
                     * @event Client#group_join
                     * @param {GroupNotification} notification GroupNotification with more information about the action
                     */
                    this.emit(Events.GROUP_JOIN, notification);
                } else if (msg.subtype === 'remove' || msg.subtype === 'leave') {
                    /**
                     * Emitted when a user leaves the chat or is removed by an admin.
                     * @event Client#group_leave
                     * @param {GroupNotification} notification GroupNotification with more information about the action
                     */
                    this.emit(Events.GROUP_LEAVE, notification);
                } else {
                    /**
                     * Emitted when group settings are updated, such as subject, description or picture.
                     * @event Client#group_update
                     * @param {GroupNotification} notification GroupNotification with more information about the action
                     */
                    this.emit(Events.GROUP_UPDATE, notification);
                }
                return;
            }

            const message = new Message(this, msg);

            /**
             * Emitted when a new message is created, which may include the current user's own messages.
             * @event Client#message_create
             * @param {Message} message The message that was created
             */
            this.emit(Events.MESSAGE_CREATE, message);

            if (msg.id.fromMe) return;

            /**
             * Emitted when a new message is received.
             * @event Client#message
             * @param {Message} message The message that was received
             */
            this.emit(Events.MESSAGE_RECEIVED, message);
        });

        let last_message;

        await page.exposeFunction('onChangeMessageTypeEvent', (msg) => {

            if (msg.type === 'revoked') {
                const message = new Message(this, msg);
                let revoked_msg;
                if (last_message && msg.id.id === last_message.id.id) {
                    revoked_msg = new Message(this, last_message);
                }

                /**
                 * Emitted when a message is deleted for everyone in the chat.
                 * @event Client#message_revoke_everyone
                 * @param {Message} message The message that was revoked, in its current state. It will not contain the original message's data.
                 * @param {?Message} revoked_msg The message that was revoked, before it was revoked. It will contain the message's original data. 
                 * Note that due to the way this data is captured, it may be possible that this param will be undefined.
                 */
                this.emit(Events.MESSAGE_REVOKED_EVERYONE, message, revoked_msg);
            }

        });

        await page.exposeFunction('onChangeMessageEvent', (msg) => {

            if (msg.type !== 'revoked') {
                last_message = msg;
            }

        });

        await page.exposeFunction('onRemoveMessageEvent', (msg) => {

            if (!msg.isNewMsg) return;

            const message = new Message(this, msg);

            /**
             * Emitted when a message is deleted by the current user.
             * @event Client#message_revoke_me
             * @param {Message} message The message that was revoked
             */
            this.emit(Events.MESSAGE_REVOKED_ME, message);

        });

        await page.exposeFunction('onMessageAckEvent', (msg, ack) => {

            const message = new Message(this, msg);

            /**
             * Emitted when an ack event occurrs on message type.
             * @event Client#message_ack
             * @param {Message} message The message that was affected
             * @param {MessageAck} ack The new ACK value
             */
            this.emit(Events.MESSAGE_ACK, message, ack);

        });

        await page.exposeFunction('onMessageMediaUploadedEvent', (msg) => {

            const message = new Message(this, msg);

            /**
             * Emitted when media has been uploaded for a message sent by the client.
             * @event Client#media_uploaded
             * @param {Message} message The message with media that was uploaded
             */
            this.emit(Events.MEDIA_UPLOADED, message);
        });

        await page.exposeFunction('onAppStateChangedEvent', (state) => {

            /**
             * Emitted when the connection state changes
             * @event Client#change_state
             * @param {WAState} state the new connection state
             */
            this.emit(Events.STATE_CHANGED, state);

            const ACCEPTED_STATES = [WAState.CONNECTED, WAState.OPENING, WAState.PAIRING, WAState.TIMEOUT];

            if (this.options.takeoverOnConflict) {
                ACCEPTED_STATES.push(WAState.CONFLICT);

                if (state === WAState.CONFLICT) {
                    setTimeout(() => {
                        this.pupPage.evaluate(() => window.Store.AppState.takeover());
                    }, this.options.takeoverTimeoutMs);
                }
            }

            if (!ACCEPTED_STATES.includes(state)) {
                /**
                 * Emitted when the client has been disconnected
                 * @event Client#disconnected
                 * @param {WAState} reason state that caused the disconnect
                 */
                this.emit(Events.DISCONNECTED, state);
                this.destroy();
            }
        });

        await page.exposeFunction('onBatteryStateChangedEvent', (state) => {
            const { battery, plugged } = state;

            if (battery === undefined) return;

            /**
             * Emitted when the battery percentage for the attached device changes
             * @event Client#change_battery
             * @param {object} batteryInfo
             * @param {number} batteryInfo.battery - The current battery percentage
             * @param {boolean} batteryInfo.plugged - Indicates if the phone is plugged in (true) or not (false)
             */
            this.emit(Events.BATTERY_CHANGED, { battery, plugged });
        });

        await page.evaluate(() => {
            window.Store.Msg.on('add', (msg) => { if (msg.isNewMsg) window.onAddMessageEvent(msg); });
            window.Store.Msg.on('change', (msg) => { window.onChangeMessageEvent(msg); });
            window.Store.Msg.on('change:type', (msg) => { window.onChangeMessageTypeEvent(msg); });
            window.Store.Msg.on('change:ack', (msg, ack) => { window.onMessageAckEvent(msg, ack); });
            window.Store.Msg.on('change:isUnsentMedia', (msg, unsent) => { if (msg.id.fromMe && !unsent) window.onMessageMediaUploadedEvent(msg); });
            window.Store.Msg.on('remove', (msg) => { if (msg.isNewMsg) window.onRemoveMessageEvent(msg); });
            window.Store.AppState.on('change:state', (_AppState, state) => { window.onAppStateChangedEvent(state); });
            window.Store.Conn.on('change:battery', (state) => { window.onBatteryStateChangedEvent(state); });
        });

        /**
         * Emitted when the client has initialized and is ready to receive messages.
         * @event Client#ready
         */
        this.emit(Events.READY);
    }

    /**
     * Closes the client
     */
    async destroy() {
        if (this._qrRefreshInterval) {
            clearInterval(this._qrRefreshInterval);
        }
        await this.pupBrowser.close();
    }

    /**
     * Logs out the client, closing the current session
     */
    async logout() {
        return await this.pupPage.evaluate(() => {
            return window.Store.AppState.logout();
        });
    }

    /**
     * Returns the version of WhatsApp Web currently being run
     * @returns {Promise<string>}
     */
    async getWWebVersion() {
        return await this.pupPage.evaluate(() => {
            return window.Debug.VERSION;
        });
    }

    /**
     * Mark as seen for the Chat
     *  @param {string} chatId
     *  @returns {Promise<boolean>} result
     * 
     */
    async sendSeen(chatId) {
        const result = await this.pupPage.evaluate(async (chatId) => {
            return window.WWebJS.sendSeen(chatId);

        }, chatId);
        return result;
    }

    /**
     * Message options.
     * @typedef {Object} MessageSendOptions
     * @property {boolean} [linkPreview=true] - Show links preview
     * @property {boolean} [sendAudioAsVoice=false] - Send audio as voice message
     * @property {string} [caption] - Image or video caption
     * @property {string} [quotedMessageId] - Id of the message that is being quoted (or replied to)
     * @property {Contact[]} [mentions] - Contacts that are being mentioned in the message
     * @property {boolean} [sendSeen=true] - Mark the conversation as seen after sending the message
     * @property {boolean} [media] - Media to be sent
     */

    /**
     * Send a message to a specific chatId
     * @param {string} chatId
     * @param {string|MessageMedia|Location} content
     * @param {MessageSendOptions} [options] - Options used when sending the message
     * 
     * @returns {Promise<Message>} Message that was just sent
     */
    async sendMessage(chatId, content, options = {}) {
        let internalOptions = {
            linkPreview: options.linkPreview === false ? undefined : true,
            sendAudioAsVoice: options.sendAudioAsVoice,
            caption: options.caption,
            quotedMessageId: options.quotedMessageId,
            mentionedJidList: Array.isArray(options.mentions) ? options.mentions.map(contact => contact.id._serialized) : []
        };

        const sendSeen = typeof options.sendSeen === 'undefined' ? true : options.sendSeen;

        if (content instanceof MessageMedia) {
            internalOptions.attachment = content;
            content = '';
        } else if (options.media instanceof MessageMedia) {
            internalOptions.attachment = options.media;
            internalOptions.caption = content;
            content = '';
        } else if (content instanceof Location) {
            internalOptions.location = content;
            content = '';
        }

        const newMessage = await this.pupPage.evaluate(async (chatId, message, options, sendSeen) => {
            const chatWid = window.Store.WidFactory.createWid(chatId);
            const chat = await window.Store.Chat.find(chatWid);

            if (sendSeen) {
                window.WWebJS.sendSeen(chatId);
            }

            const msg = await window.WWebJS.sendMessage(chat, message, options, sendSeen);
            return msg.serialize();
        }, chatId, content, internalOptions, sendSeen);

        return new Message(this, newMessage);
    }

    /**
     * Get all current chat instances
     * @returns {Promise<Array<Chat>>}
     */
    async getChats() {
        let chats = await this.pupPage.evaluate(async () => {
            return await window.WWebJS.getChats();
        });

        return chats.map(chat => ChatFactory.create(this, chat));
    }

    /**
     * Get chat instance by ID
     * @param {string} chatId 
     * @returns {Promise<Chat>}
     */
    async getChatById(chatId) {
        let chat = await this.pupPage.evaluate(async chatId => {
            return await window.WWebJS.getChat(chatId);
        }, chatId);

        return ChatFactory.create(this, chat);
    }

    /**
     * Get all current contact instances
     * @returns {Promise<Array<Contact>>}
     */
    async getContacts() {
        let contacts = await this.pupPage.evaluate(() => {
            return window.WWebJS.getContacts();
        });

        return contacts.map(contact => ContactFactory.create(this, contact));
    }

    /**
     * Get contact instance by ID
     * @param {string} contactId
     * @returns {Promise<Contact>}
     */
    async getContactById(contactId) {
        let contact = await this.pupPage.evaluate(contactId => {
            return window.WWebJS.getContact(contactId);
        }, contactId);

        return ContactFactory.create(this, contact);
    }

    /**
     * Returns an object with information about the invite code's group
     * @param {string} inviteCode 
     * @returns {Promise<object>} Invite information
     */
    async getInviteInfo(inviteCode) {
        return await this.pupPage.evaluate(inviteCode => {
            return window.Store.Wap.groupInviteInfo(inviteCode);
        }, inviteCode);
    }

    /**
     * Accepts an invitation to join a group
     * @param {string} inviteCode Invitation code
     */
    async acceptInvite(inviteCode) {
        const chatId = await this.pupPage.evaluate(async inviteCode => {
            return await window.Store.Invite.sendJoinGroupViaInvite(inviteCode);
        }, inviteCode);

        return chatId._serialized;
    }

    /**
     * Sets the current user's status message
     * @param {string} status New status message
     */
    async setStatus(status) {
        await this.pupPage.evaluate(async status => {
            return await window.Store.Wap.sendSetStatus(status);
        }, status);
    }

    /**
     * Sets the current user's display name. 
     * This is the name shown to WhatsApp users that have not added you as a contact beside your number in groups and in your profile.
     * @param {string} displayName New display name
     */
    async setDisplayName(displayName) {
        await this.pupPage.evaluate(async displayName => {
            return await window.Store.Wap.setPushname(displayName);
        }, displayName);
    }

    /**
     * Gets the current connection state for the client
     * @returns {WAState} 
     */
    async getState() {
        return await this.pupPage.evaluate(() => {
            return window.Store.AppState.state;
        });
    }

    /**
     * Marks the client as online
     */
    async sendPresenceAvailable() {
        return await this.pupPage.evaluate(() => {
            return window.Store.Wap.sendPresenceAvailable();
        });
    }

    /**
     * Enables and returns the archive state of the Chat
     * @returns {boolean}
     */
    async archiveChat(chatId) {
        return await this.pupPage.evaluate(async chatId => {
            let chat = await window.Store.Chat.get(chatId);
            await window.Store.Cmd.archiveChat(chat, true);
            return chat.archive;
        }, chatId);
    }

    /**
     * Changes and returns the archive state of the Chat
     * @returns {boolean}
     */
    async unarchiveChat(chatId) {
        return await this.pupPage.evaluate(async chatId => {
            let chat = await window.Store.Chat.get(chatId);
            await window.Store.Cmd.archiveChat(chat, false);
            return chat.archive;
        }, chatId);
    }

    /**
     * Mutes the Chat until a specified date
     * @param {string} chatId ID of the chat that will be muted
     * @param {Date} unmuteDate Date when the chat will be unmuted
     */
    async muteChat(chatId, unmuteDate) {
        await this.pupPage.evaluate(async (chatId, timestamp) => {
            let chat = await window.Store.Chat.get(chatId);
            await chat.mute.mute(timestamp, !0);
        }, chatId, unmuteDate.getTime() / 1000);
    }

    /**
     * Unmutes the Chat
     * @param {string} chatId ID of the chat that will be unmuted
     */
    async unmuteChat(chatId) {
        await this.pupPage.evaluate(async chatId => {
            let chat = await window.Store.Chat.get(chatId);
            await window.Store.Cmd.muteChat(chat, false);
        }, chatId);
    }

    /**
     * Returns the contact ID's profile picture URL, if privacy settings allow it
     * @param {string} contactId the whatsapp user's ID
     * @returns {Promise<string>}
     */
    async getProfilePicUrl(contactId) {
        const profilePic = await this.pupPage.evaluate((contactId) => {
            return window.Store.Wap.profilePicFind(contactId);
        }, contactId);

        return profilePic ? profilePic.eurl : undefined;
    }

    /**
     * Force reset of connection state for the client
    */
    async resetState() {
        await this.pupPage.evaluate(() => {
            window.Store.AppState.phoneWatchdog.shiftTimer.forceRunNow();
        });
    }

    /**
     * Check if a given ID is registered in whatsapp
     * @param {string} id the whatsapp user's ID
     * @returns {Promise<Boolean>}
     */
    async isRegisteredUser(id) {
        return await this.pupPage.evaluate(async (id) => {
            let result = await window.Store.Wap.queryExist(id);
            return result.jid !== undefined;
        }, id);
    }

    /**
     * Create a new group
     * @param {string} name group title
     * @param {Array<Contact|string>} participants an array of Contacts or contact IDs to add to the group
     * @returns {Object} createRes
     * @returns {string} createRes.gid - ID for the group that was just created
     * @returns {Object.<string,string>} createRes.missingParticipants - participants that were not added to the group. Keys represent the ID for participant that was not added and its value is a status code that represents the reason why participant could not be added. This is usually 403 if the user's privacy settings don't allow you to add them to groups.
     */
    async createGroup(name, participants) {
        if (!Array.isArray(participants) || participants.length == 0) {
            throw 'You need to add at least one other participant to the group';
        }

        if (participants.every(c => c instanceof Contact)) {
            participants = participants.map(c => c.id._serialized);
        }

        const createRes = await this.pupPage.evaluate(async (name, participantIds) => {
            const res = await window.Store.Wap.createGroup(name, participantIds);
            console.log(res);
            if (!res.status === 200) {
                throw 'An error occurred while creating the group!';
            }

            return res;
        }, name, participants);

        const missingParticipants = createRes.participants.reduce(((missing, c) => {
            const id = Object.keys(c)[0];
            const statusCode = c[id].code;
            if (statusCode != 200) return Object.assign(missing, { [id]: statusCode });
            return missing;
        }), {});

        return { gid: createRes.gid, missingParticipants };
    }

}

module.exports = Client;
