﻿/*

This file is part of Streembit application. 
Streembit is an open source communication application. 

Streembit is a free software: you can redistribute it and/or modify it under the terms of the GNU General Public License 
as published by the Free Software Foundation, either version 3.0 of the License, or (at your option) any later version.

Streembit is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty 
of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with Streembit software.  
If not, see http://www.gnu.org/licenses/.
 
-------------------------------------------------------------------------------------------------------------------------
Author: Tibor Zsolt Pardi 
Copyright (C) Streembit 2017
-------------------------------------------------------------------------------------------------------------------------

Websocket implementation of the City of Osmio P2P network

*/

'use strict';

const async = require('async');
const logger = require('./logger');
const config = require('./config');
const appevents = require("appevents");
const appsrvc = require('./appsrvc');
const defs = require('./definitions');
const settings = require('./settings');
const socketio = require('socket.io-client');
const Buffer = require('buffer').Buffer;
const secrand = require('secure-random');
const database = require('database');
const bs58check = require('bs58check');
const peermsg = require('peermsg');
const createHmac = require('create-hmac');

const SOCKCONN_TIMEOUT = 8000;

function IoTHub(host, port, protocol, id, publickey, devices) {

    this.protocol = protocol || "wss"; // ws or wss (wss for WS over TLS)
    this.wssocket = 0;
    this.host = host;
    this.port = port;
    this.connected = false;
    this.lastping = false;
    this.id = id;
    this.publickey = publickey;
    this.devices = devices;
    this.pendingmsgs = new Map();
    this.authtoken = 0;

    this.onMessage = function (event) {
        try {
            //console.log("ws message ", event.data ? event.data : event);
            var response = JSON.parse(event.data);
            var error = response.error;

            if (response.txn) {
                if (!this.pendingmsgs.has(response.txn)) {
                    if (error) {
                        throw new Error("WebSocket onMessage received error " + error);
                    }
                }

                var txn = response.txn;
                var callback = this.pendingmsgs.get(txn);

                // remove the pending txn
                this.pendingmsgs.delete(txn);

                if (!callback) {
                    if (error) {
                        throw new Error("WebSocket onMessage received error " + error);
                    }
                }
                else {
                    if (error) {
                        return callback(error);
                    }

                    callback(null, response.payload);
                }

                //
            }
            else {
                appevents.emit(
                    appevents.WS_DATARCV_EVENT,
                    response.payload
                );
            }

            //
        }
        catch (err) {
            logger.error("WebSocket onMessage error %j", err);
        }
    }

    this.onError = function (evt) {
        logger.error("IoTHub WebSocket error %j", evt.data || "");
    }

    this.onDisconnect = function (event) {
        logger.info('web socket is disconnected %s', (event || ""), null, true);
    }

    this.send = function (message, callback) {
        if (!this.wssocket) {
            return;
        }

        var txn = secrand.randomBuffer(8).toString("hex");
        var hmac = createHmac('sha256', this.authtoken);
        hmac.update(txn);
        var hmacdigest = hmac.digest('hex');
        message.txn = txn;
        message.pkhash = appsrvc.pubkeyrmd160hash;
        message.hmacdigest = hmacdigest;
        this.pendingmsgs.set(txn, callback);

        var strmsg = JSON.stringify(message);
        this.wssocket.send(strmsg)
    }

    this.sendauth = function (message, callback) {
        if (!this.wssocket) {
            return;
        }

        var txn = secrand.randomBuffer(8).toString("hex");
        message.txn = txn;
        this.pendingmsgs.set(txn, callback);

        var strmsg = JSON.stringify(message);
        this.wssocket.send(strmsg)
    }

    this.open = function (callback) {
        var self = this;

        try {
            if (!this.host) {
                return callback("invalid WS host");
            }
            if (!this.port) {
                return callback("invalid WS port");
            }
            if (this.protocol != "ws" && this.protocol != "wss") {
                return callback("invalid WS protocol");
            }

            var wsserver = "ws://" + this.host + ":" + this.port;
            logger.debug("create web socket at " + wsserver);

            var conntimer = 0;
            var is_wsconnected = false;
            try {
                this.wssocket = new WebSocket(wsserver);
            }
            catch (err) {
                return callback("Create WebSocket error " + err.message);
            }

            this.wssocket.onopen = (e) => {
                is_wsconnected = true;                
                if (conntimer) {
                    clearTimeout(conntimer);
                }
                this.connected = true;
                callback();
            };         

            // Listen for messages
            this.wssocket.onmessage = (e) => {
                this.onMessage(e);
            };

            this.wssocket.onerror = this.onError;
            this.wssocket.onclose = this.onDisconnect;

            conntimer = setTimeout(
                () => {
                    if (!is_wsconnected) {
                        return callback("web socket connect to " + this.host + " timed out");
                    }

                    this.connected = true;
                },
                SOCKCONN_TIMEOUT
            );

            //
        }
        catch (err) {
            return callback("Create websocket error: " + err.message);
        }

    }
}


function IoTHubsHandler(address, port) {

    this.hubs = new Map();

    this.gethostinfo = function (id, host, port, callback) {
        //TODO get the host infor from hte DHT
        callback(null, host, port);
    }

    this.create_connection = function (id, publickey, port, host, protocol, devices, callback) {
        try {
            var conn = new IoTHub(host, port, protocol, id, publickey, devices );
            conn.open((err) => {
                if (err) {
                    return callback(err);
                }

                this.hubs.set(id, conn);
                callback();
            });
        }
        catch (err) {
            callback(err);
        }
    }

    this.authenticate = function (id) {
        try {
            var hub = this.hubs.get(id);
            var hub_public_key = hub.publickey;
            var buffer = bs58check.decode(hub_public_key);
            var contact_public_key = buffer.toString("hex");

            var user_public_key = appsrvc.publicKeyBs58;

            var token = secrand.randomBuffer(32).toString("hex");
            var plain = {
                session_token: token,
                pkhash: appsrvc.pubkeyrmd160hash
            };

            var plaindata = JSON.stringify(plain);
            var cipher = peermsg.ecdh_encypt(appsrvc.cryptokey, contact_public_key, plaindata);

            var payload = {
                type: peermsg.MSGTYPE.IOTAUTH
            };
            payload[peermsg.MSGFIELD.CIPHER] = cipher;

            var msgid = secrand.randomBuffer(8).toString("hex");
            var jwtoken = peermsg.create_jwt_token(appsrvc.cryptokey, msgid, payload, null, null, user_public_key, null, hub_public_key);

            var message = {
                auth: true,
                jwt: jwtoken
            };

            hub.sendauth(message, function (err, response) {
                if (err) {
                    return logger.error("IoT Hub responded authenticate error: %j", err);
                }

                // expecting response.authenticated == true
                if (!response || !response.authenticated) {
                    return logger.error("IoT Hub reponded authentication failed");
                }

                // set the security token
                hub.authtoken = token;
                logger.debug("Authenticated at IOT Hub " + hub.host);
            });

            //
        }
        catch (err) {
            logger.error("IoT hub authenticate error: %j", err);
        }
    }

    this.inithub = function (id, device) {
        logger.debug("init IoT Hub id: " + id + " host: " + device.host + " port: " + device.port);

        var publickey = device.publickey;
        var protocol = device.protocol;
        var devices = device.devices;

        async.waterfall(
            [
                (cbfn) => {
                    this.gethostinfo(id, device.host, device.port, cbfn)
                },
                (host, port, cbfn) => {
                    //TODO remove start
                    port = 32318;
                    host = "192.168.1.76";
                    protocol = "ws";
                    //TODO remove end
                    this.create_connection(id, publickey, port, host, protocol, devices, cbfn);
                }            
            ],
            (err) => {
                if (err) {
                    return logger.error("IoTHubsHandler inithub() error %j", err);
                }

                // initialize the session with the gateway
                this.authenticate(id);
            }
        );
    }

    this.init = function () {

        try {
            logger.debug("IoTHubsHandler init");

            // get all iot hubs from the database 
            database.IoTDB.get_devices( (err, result) => {
                if (err) {
                    return logger.error("IoT Hub initialize devices list error: %j", err);
                }

                if (!result && !Array.isArray(result)) {
                    logger.info("No IoT device exists in the local database");
                }
                
                result.forEach((item) => {
                    this.inithub(item.id, item);
                });                
            });

            appevents.addListener("iot-hub-send", (id, message, callback) => {
                //debugger;
                try {
                    if (!this.hubs || !this.hubs.has(id)) {
                        return callback("The IoT Hub is not configured");
                    }
                  
                    var hub = this.hubs.get(id);
                    hub.send(message, callback);

                    //
                }
                catch (err) {
                    streembit.notify.error("WS hub send error %s", err.message);
                }
            });

            //
        }
        catch (e) {
            logger.error("IoTHubsHandler init error %j", e);
        }

    }
}

module.exports = IoTHubsHandler;