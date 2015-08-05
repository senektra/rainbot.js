/* global rainlog, __config */
"use strict";

const irc = require('irc');
const fs = require('fs');
const async = require('async');

const hookHandler = require('./hookhandler');
const respondQueue = require('./responders/respondqueue');
const alias = require('./alias');
const ircHelpers = require('./irc');

const modulesFolder = __dirname + '/../modules/';

class Bot extends irc.Client {

  /**
   * Creates an instance of the bot. Inherits from irc.Client.
   *
   * @constructor
   * @param {String} server - Server to connect to
   * @param {String} nick - Nick to use for connection
   * @param {Object} options - Options to pass to superclass
   */

  constructor(server, nick, options) {
    rainlog.info('Bot', 'Initializing bot...');
    super(server, nick, options);
    this.version = '0.7.0 (Rarity\'s Grace)';
    this.Module = require('./module')(this);
    this.alias = alias;
    this.irc = ircHelpers(this);
    this.modules = [];
    this.config = __config;
    this.sleep = false;
    alias.loadAliases();
    respondQueue.setBot(this);
  }

  /**
   * Loads modules from the modules directory. Makes sure that
   * path is a directory and that modules export an instance of
   * the Module class. The hook handler is called to extract hooks.
   *
   * @param {Function} callback - Called when all modules are loaded.
   */

  loadModules(callback) {
    rainlog.info('Bot', 'Loading modules...');
    const self = this;
    fs.readdir(modulesFolder, function(err, modules) {
      async.each(modules, function(moduleDir, next) {
        if (!fs.lstatSync(modulesFolder + moduleDir).isDirectory()) {
          rainlog.warn('Bot', `${moduleDir} is not a module directory`);
          return next();
        }
        require(modulesFolder + moduleDir)(self.Module, function(module) {
          if (!(module instanceof self.Module)) {
            rainlog.err('Bot', `${moduleDir} is not a module`);
            rainlog.err('Bot', 'Make sure that module exports a Module instance');
            return next();
          }
          self.modules.push(module);
          hookHandler.extractHooks(module);
          rainlog.info('Bot', `Loaded module: ${module.name}`);
          return next();
        });
      }, function(err) {
        return callback();
      });
    });
  }

  setUpPastebin(pastebinApiSettings) {
    if (!pastebinApiSettings || !pastebinApiSettings.api_dev_key) return;
    const PastebinAPI = require('pastebin-js');
    respondQueue.setPastebinApi(new PastebinAPI(pastebinApiSettings));
  }

  /**
   * Loads modules and attaches hooks before connecting to IRC.
   *
   * @param {Function} callback
   *    Called when modules are loaded and hooks are attached.
   */

  preStart(callback) {
    const self = this;
    self.loadModules(function() {
      self.attachHooks(function() {
        require('./../config/init')(self, callback);
      });
    });
  }

  /**
   * First temporarily caches nsPassword and pastebinApi from the config
   * and then sets them to empty strings in the config so that modules
   * can't reference them. Then attempts to indentify with NickServ if
   * nsPassword was set and creates a pastebin object if that was set
   * as well. Lastly, it attempts to connect to IRC and joins each channel
   * listed in the config via {@link bot~gate}
   */

  start() {
    const self = this;
    rainlog.info('Bot', 'Starting bot...');

    const nsPassword = __config.nsPassword;
    this.setUpPastebin(__config.pastebinApi);

    rainlog.info('Bot', 'Unsetting nsPassword and Pastebin API in config');
    __config.nsPassword = '';
    __config.pastebinApi = '';

    this.preStart(connect);
    
    function connect() {
      self.connect(postStart);
    }
    
    function postStart() {
      rainlog.info('Bot', 'Bot connected to IRC');
      if (nsPassword) self.send('ns', 'identify', nsPassword);
      if (__config.modeList)
        self.send('mode', __config.nick, __config.modeList);
      rainlog.info('Bot', 'Connecting to channels');
      for (let channel of __config.channels) self.gate(channel);
    }
  }

  /**
   * Dispatches events to modules.
   *
   * @param {String} event - The event to fire.
   * @param {Object} params - Params containing event information.
   */

  dispatch(event, params) {
    const self = this;
    if (self.sleep) return;
    rainlog.debug('Bot', `Dispatching event: ${event}`);
    hookHandler.fire(event, params);
  }

  /**
   * Attaches listeners to the bot which dispatch events to modules.
   *
   * @param {Function} callback - Called when all listeners are attached.
   */

  attachHooks(callback) {
    const self = this;

    this.addListener('registered', function(msg) {
      self.dispatch('registered', { msg });
    });

    // Notice Events

    this.addListener('notice', function(nick, to, text, msg) {
      self.dispatch('notice', { from: nick, to, text, msg });
    });

    // Message Events

    this.addListener('message', function(nick, to, text, msg) {
      self.dispatch('message', { from: nick, to, text, msg });
    });

    // Action Events

    this.addListener('action', function(from, to, text, msg) {
      self.dispatch('action', { from, to, text, msg });
    });

    // Names events

    this.addListener('names', function(channel, nicks) {
      self.dispatch('names', { channel, nicks });
    });

    // Join Events
    this.addListener('join', function(channel, nick, msg) {
        self.dispatch('join', { channel, nick, msg });
    });

    // Part events

    this.addListener('part', function(channel, nick, reason, msg) {
      self.dispatch('part', { channel, nick, reason, msg });
    });

    // Kick events
    this.addListener('kick', function(channel, nick, by, reason, message) {
      self.dispatch('kick', { channel, nick, by, reason, msg: message });
    });

    // Kill events
    this.addListener('kill', function(nick, reason, channels, message) {
      self.dispatch('kill', { nick, reason, channels, msg: message });
    });

    // Quit events

    this.addListener('quit', function(nick, reason, channels, msg) {
      self.dispatch('quit', { nick, reason, channels, msg });
    });

    // Nicks Events

    this.addListener('nick', function(oldnick, newnick, channels, msg) {
      self.dispatch('nick',
        { oldnick: oldnick, newnick: newnick, channels: channels, msg: msg }
      );
    });

    // PM events

    this.addListener('pm', function(nick, text, msg) {
      self.dispatch('pm', { from: nick, text: text, msg: msg });
    });

    // Ping events

    this.addListener('ping', function(server) {
      rainlog.info('Bot', `:Pong ${server}`);
      self.dispatch('ping', { server: server });
    });

    // Error events

    this.addListener('error', function(message) {
      rainlog.err('Server', message.args[1]);
    });

    // Finished attaching hooks
    return callback();
  }

  /**
   * Puts the bot to 'sleep' and wakes when all replay messages have passed.
   *
   * FIXME: Bugs out when bot lags in joining.
   * TODO: Maybe find a more surefire way to find replay messages (Servers
   *       may have different replay messages, commands, etc.).
   *
   * @param {String} channel - Channel to join.
   */

  gate(channel) {
    const self = this;
    self.addListener('raw', function gate(message) {
      if (self.sleep && message.command !== 'PRIVMSG') {
        self.removeListener('raw', gate);
        self.sleep = false;
      }
      if (message.args[1] && message.args[1].indexOf('Replaying up to') > -1) {
        self.sleep = true;
        rainlog.debug('Bot', 'Gating channel ' + channel);
      }
    });
    if (channel) this.join(channel);
    rainlog.info('Bot', 'Joined ' + channel);
  }
}

module.exports = Bot;