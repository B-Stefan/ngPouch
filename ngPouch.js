'use strict';

angular.module('ngPouch', ['angularLocalStorage', 'mdo-angular-cryptography'])
  .service('ngPouch', function($timeout, $q, storage, $crypto) {

    //FIXME the storage implementation is not working and based on a misconception of what angularLocalStorage is doing
    // at the moment all stored values are just attached as properties to the service object and never make their
    // way into localStorage

    var service = {
      // Databases
      /*global PouchDB*/
      db: new PouchDB("LocalDB"),
      remotedb: undefined,

      // Options
      invokeApply: true,


      // Persistent Settings
      settings: {
        database: undefined,
        username: undefined,
        password: undefined, //FIXME can we get more secure than this?
        stayConnected: undefined
      },

      // Persistent Status
      status: {
        localChanges: 0,
        changeEvents: {},
        replicationToEvents: {},
        replicationFromEvents: {}
      },

      // Session Status
      session: {
        // Session Stats
        status: "offline",
        docsSent: 0,
        docsReceived: 0,
        currentRetryDelay: 10,
        maxRetryDelay: 60 * 1000 * 10,
        retryDelayInc: 1000,
        lastConnectionAttempt: undefined,
        publishInProgress: false
      },

      // Promises & Even Emitters
      changes: undefined,
      replicationTo: undefined,
      replicationFrom: undefined,
      delayStatusPromise: undefined,
      retryPromise: undefined,
      publishPromise: undefined,

      /*
       *  Initializers
       *
       */

      init: function() {
        // Load Persistent Data
        this.loadSettings();
        this.loadStatus();

        // Start Session
        this.trackChanges();
        this.initRobustSync(1000);

        this.initEncryption();

        // Had to use these functions somewhere
        // to get WebStorm to turn green.
        // This is a really silly use of them
        return [this.statusIcon(), this.statusTitle()];
      },


      /*
       *  storage aware accessors for settings and status
       */

      incrementLocalChanges: function() {
        var self = this;
        if (typeof self.status.localChanges === "number") {
          self.status.localChanges++;
        } else {
          self.status.localChanges = 1;
        }
        this.persistStatus();
      },

      resetLocalChanges: function() {
        this.status.localChanges = 0;
        this.persistStatus();
      },

      storeChangeEvent: function(value, event) {
        var self = this;
        if (typeof self.status.changeEvents === "undefined") {
          self.status.changeEvents = {};
        }
        self.status.changeEvents[event] = value;
        self.persistStatus();
      },

      storeReplicationToEvent: function(value, event) {
        var self = this;
        if (typeof self.status.replicationToEvents === "undefined") {
          self.status.replicationToEvents = {};
        }

        self.status.replicationToEvents[event] = value;
        self.persistStatus();
      },

      storeReplicationFromEvent: function(value, event) {
        var self = this;
        if (typeof self.status.replicationFromEvents === "undefined") {
          self.status.replicationFromEvents = {};
        }
        self.status.replicationFromEvents[event] = value;
        self.persistStatus();
      },

      persistStatus: function() {
        storage.pouchStatus = this.status;
      },

      loadSettings: function() {
        if (typeof storage.pouchSettings !== "undefined") {
          this.settings = storage.pouchSettings;
        }
      },

      loadStatus: function() {
        if (typeof storage.pouchStatus !== "undefined") {
          this.status = storage.pouchStatus;
        }
      },

      /*
       *  Public Methods
       */


      publish: function(f) {
        // Cancel previous publishers from other controllers
        // Run the function immediately and then again on database changes
        // Prevent from getting called while in progress

        var self = this;
        self.session.publishInProgress = false;

        var runFn = function(info) {
          if (self.session.publishInProgress === false) {
            self.session.publishInProgress = true;
            f().finally(function() {
              $timeout(function() {
                self.session.publishInProgress = false;
              }, 0, self.invokeApply);
            });
          }
        };

        self.db.info(function(err, info) {

          if (typeof self.publishPromise !== "undefined") {
            if (typeof self.publishPromise.cancel !== "undefined") {
              self.publishPromise.cancel();
            }
          }

          self.publishPromise = self.db.changes({
            since: (info.update_seq - 1),
            live: true
          }).on('change', runFn);

        });

        runFn();
      },

      getSettings: function() {
        return this.settings;
      },

      setSettings: function(settings) {
        this.settings = settings;
        this.initRobustSync(1000);
      },

      saveSettings: function(settings) {
        this.settings = settings;
        storage.pouchSettings = this.getSettings();
        this.initRobustSync(1000);
      },

      localChanges: function() {
        if (typeof this.status === "undefined") {
          return "undefined";
        } else {
          return this.status.localChanges;
        }
      },

      statusIcon: function() {
        switch (this.session.status) {
          case "connecting":
            return "ion-ios7-cloudy-night-outline";
          case "online":
            return "ion-ios7-cloud-outline";
          case "offline":
            return "ion-ios7-cloudy-night";
          case "idle":
            return "ion-ios7-cloud-outline";
          case "receiving":
            return "ion-ios7-cloud-download-outline";
          case "sending":
            return "ion-ios7-cloud-upload-outline";
          default:
            return "ion-alert-circled";
        }
      },

      statusTitle: function() {
        switch (this.session.status) {
          case "online":
            return "Connected";
          case "connecting":
            return "Trying to connect";
          case "offline":
            return "Not connected";
          case "idle":
            return "Connected";
          case "receiving":
            return "Receiving Data";
          case "sending":
            return "Sending Data";
          default:
            return "Unknown Status";
        }
      },

      // Destroy and recreated local db and changes db
      reset: function() {
        var self = this;
        PouchDB.destroy("LocalDB").then(function() {
          storage.pouchStatus = {};
          storage.session = {};
          self.disconnect();
          self.init();
        });
      },

      /*
       *  Private Methods
       */


      initRobustSync: function(delay) {
        var self = this;
        self.session.currentRetryDelay = delay;
        self.cancelProgressiveRetry();

        if (self.settings.stayConnected === true) {
          self.progressiveRetry();
        }
      },

      attemptConnection: function() {
        var self = this;
        self.session.lastConnectionAttempt = new Date();
        self.flashSessionStatus("connecting");
        return self.connect();
      },


      maxOutProgressiveDelay: function() {
        this.initRobustSync(this.session.maxRetryDelay);
      },

      restartProgressiveDelay: function() {
        if (this.session.status !== "connecting" &&
          this.session.status !== "offline") {
          this.initRobustSync(1000);
        }
      },

      cancelProgressiveRetry: function() {
        var self = this;
        if (typeof self.retryPromise === "object") {
          $timeout.cancel(self.retryPromise);
        }
      },

      progressiveRetry: function() {
        var self = this;
        if (self.session.currentRetryDelay < self.session.maxRetryDelay) {
          self.session.currentRetryDelay = self.session.currentRetryDelay + self.session.retryDelayInc;
        }

        self.retryPromise = $timeout(function() {
          self.progressiveRetry();
          self.attemptConnection();
        }, self.session.currentRetryDelay, false);
      },

      flashSessionStatus: function(status) {
        var self = this;
        var s = self.session.status;
        self.setSessionStatus(status);
        self.delaySessionStatus(2000, s);
      },

      setSessionStatus: function(status) {
        var self = this;
        self.cancelSessionStatus();
        $timeout(function() {
          self.session.status = status;
        }, 0, self.invokeApply);
      },

      delaySessionStatus: function(delay, status) {
        var self = this;
        self.cancelSessionStatus();
        self.delayStatusPromise = $timeout(
          function() {
            self.setSessionStatus(status);
          }, delay, self.invokeApply);
      },

      cancelSessionStatus: function() {

        var self = this;
        if (typeof self.delayStatusPromise === "object") {
          $timeout.cancel(self.delayStatusPromise);
        }
      },

      /**
       * Check the key and value, if value is to encrypt returns true
       * @param key The key in the doc
       * @param value The value in the doc
       * @returns {boolean} true if key is to encrypt
       */
      isKeyInEncryptionList: function(key, value) {

        var exclusiveDisable = [
          'docType',
          'encrypted'
        ];

        //Excluded by exclusiveDisable array
        if (exclusiveDisable.indexOf(key) > -1) {
          return false;
          //Internal field
        } else if (key.substr(0, 1) === '_') {
          return false;
        } else if (typeof value === 'function') {
          return false;
        } else {
          return true;
        }
      },

      recursiveObjectEncryptDecrypt: function(obj, encryptDecryptFunction, password) {
        var self = this;

        for (var key in obj) {

          if (obj.hasOwnProperty(key)) {

            var val = obj[key];
            if (self.isKeyInEncryptionList(key, val)) {

              if (angular.isDate(val)) {
                obj[key] = encryptDecryptFunction.call(this, val.toString(), password);
                //Recursive call if object
              } else if (typeof val === 'object') {
                obj[key] = self.recursiveObjectEncryptDecrypt.call(self, val, encryptDecryptFunction, password);
                //Recursive call for each element if array
              } else if (angular.isArray(val)) {
                for (var i = 0; i < val.length; i++) {
                  val[i] = self.recursiveObjectEncryptDecrypt.call(self, val[i], encryptDecryptFunction, password);
                }
                //If normal val
              } else {
                if(angular.isDefined(val)) {
                  obj[key] = encryptDecryptFunction.call(this, val.toString(), password);
                }
              }
            }
            if (typeof val === 'function') {
              delete obj[key];
            }
          }
        }

        return obj;
      },
      /**
       *
       */
      initEncryption: function() {
        var self = this;
        if (!self.db.transform) {
          throw new Error("Please use the pouchdb.transform plugin, see bower.json");
        } else {
          self.db.transform({
            incoming: function(doc) {
              if (doc._id.indexOf('_design') > -1 || doc._id.indexOf('org.couchdb.user:') > -1) {
                return doc;
              } else if (doc.encrypted === true) {
                return doc;
              } else if (doc.encrypted === false) {
                doc = self.recursiveObjectEncryptDecrypt(doc, $crypto.encrypt, self.settings.password);
                doc.encrypted = true;
                return doc;
              } else {
                return doc;
              }
            },
            outgoing: function(doc) {
              if (doc._id.indexOf('_design') > -1 || doc._id.indexOf('org.couchdb.user:') > -1) {
                return doc;
              } else if (doc.encrypted === false) {
                return doc;
              } else if (doc.encrypted === true) {
                doc = self.recursiveObjectEncryptDecrypt(doc, $crypto.decrypt, self.settings.password);
                doc.encrypted = false;
                return doc;
              } else {
                return doc;
              }
            }
          });
        }
      },
      initRemoteEncryption: function() {
        var self = this;

        self.remotedb.transform({
          incoming: function(doc) {
            if (doc._id.indexOf('_design') > -1) {
              return doc;
            } else if (doc.encrypted === true) {
              return doc;
            } else if (doc.encrypted === false) {
              doc = self.recursiveObjectEncryptDecrypt(doc, $crypto.encrypt, self.settings.password);
              doc.encrypted = true;
              return doc;
            } else {
              return doc;
            }
          },
          outgoing: function(doc) {
            if (doc._id.indexOf('_design') > -1) {
              return doc;
            } else if (doc.encrypted === false) {
              doc = self.recursiveObjectEncryptDecrypt(doc, $crypto.encrypt, self.settings.password);
              doc.encrypted = true;
              return doc;
            } else if (doc.encrypted === true) {
              return doc;
            } else {
              return doc;
            }
          }
        });
      },
      trackChanges: function() {
        var self = this;
        if (typeof self.changes === "object") {
          self.changes.cancel();
        }
        self.db.info()
          .then(function(info) {
            self.changes = self.db.changes({
                since: info.update_seq,
                live: true
              })
              .on('change', function(info) {
                self.handleChanges(info, "change");
              })
              .on('error', function(info) {
                self.handleChanges(info, "error");
              })
              .on('complete', function(info) {
                self.handleChanges(info, "complete");
              });
          });

      },

      handleChanges: function(info, event) {
        var self = this;
        info.occurred_at = new Date();
        self.storeChangeEvent(info, event);
        if (event === "change") {
          $timeout(function() {
            self.incrementLocalChanges();
          }, 0, self.invokeApply);
        }

      },

      handleReplicationFrom: function(info, event) {
        var self = this;
        info.occurred_at = new Date();
        self.storeReplicationFromEvent(info, event);
        switch (event) {
          case "uptodate":
            self.maxOutProgressiveDelay();
            self.delaySessionStatus(800, "idle");
            break;
          case "error":
            self.restartProgressiveDelay();
            self.delaySessionStatus(800, "offline");
            break;
          case "complete":
            //self.restartProgressiveDelay();
            //self.delaySessionStatus(800, "offline");
            break;
          case "change":
            self.maxOutProgressiveDelay();
            if (info.docs_written > self.session.docsReceived) {
              self.session.docsReceived = info.docs_written;
              self.setSessionStatus("receiving");
            }
            break;
        }
      },

      handleReplicationTo: function(info, event) {
        var self = this;
        switch (event) {
          case "uptodate":
            self.maxOutProgressiveDelay();
            self.resetLocalChanges();
            self.delaySessionStatus(800, "idle");
            break;
          case "error":
            self.restartProgressiveDelay();
            self.delaySessionStatus(800, "offline");
            break;
          case "complete":
            //self.restartProgressiveDelay();
            //self.delaySessionStatus(800, "offline");
            break;
          case "change":
            self.maxOutProgressiveDelay();
            if (info.docs_written > self.session.docsSent) {
              self.session.docsSent = info.docs_written;
              self.setSessionStatus("sending");
            }
            break;
        }
        info.occurred_at = new Date();
        this.storeReplicationToEvent(info, event);
      },


      // Disconnect from Remote Database
      disconnect: function() {
        var self = this;
        if (typeof self.session.replicationTo === "object") {
          console.log("disconnect to");
          self.session.replicationTo.cancel();
        }

        if (typeof self.session.replicationFrom === "object") {
          console.log("disconnect from");
          self.session.replicationFrom.cancel();
        }
      },
      createRemoteDb: function() {

        var deferred = $q.defer();
        var self = this;

        if (typeof self.settings.database === "string") {
          self.remotedb = new PouchDB(this.settings.database, {skipSetup:true});
          if (typeof self.settings.username === "string" && typeof self.settings.password === "string") {
            self.remotedb.login(this.settings.username, this.settings.password, function(err, response) {
              if (err) {
                deferred.reject(err);
              } else {
                self.initRemoteEncryption();
                deferred.resolve(response);
              }
            });
          } else {
            deferred.resolve();
          }
        } else {
          deferred.reject();
        }

        return deferred.promise;
      },

      logoff: function() {

        var deferred = $q.defer();
        var self = this;

        self.settings['stayConnected'] = false;
        storage.pouchSettings = self.getSettings();
        self.cancelProgressiveRetry();
        self.disconnect();
        self.delaySessionStatus(800, "offline");

        if (self.remotedb) {
          self.remotedb.logout(function(error, response) {
            self.remotedb = undefined;

            if (error) {
              deferred.reject(error);
            } else {
              deferred.resolve(response);
            }
          });
        } else {
          deferred.resolve();
        }

        return deferred.promise;
      },

      // Connect to Remote Database and Start Replication
      connect: function() {
        var self = this;
        self.session.docsSent = 0;
        self.session.docsReceived = 0;
        self.disconnect();
        var promise = self.createRemoteDb();

        self.session.replicationTo = self.db.replicate.to(self.remotedb, {
            live: true
          })
          .on('change', function(info) {
            self.handleReplicationTo(info, "change");
          })
          .on('uptodate', function(info) {
            self.handleReplicationTo(info, "uptodate");
          })
          .on('error', function(info) {
            self.handleReplicationTo(info, "error");
          })
          .on('complete', function(info) {
            self.handleReplicationTo(info, "complete");
          });

        self.session.replicationFrom = self.db.replicate.from(self.remotedb, {
            live: true
          })
          .on('change', function(info) {
            self.handleReplicationFrom(info, "change");
          })
          .on('uptodate', function(info) {
            self.handleReplicationFrom(info, "uptodate");
          })
          .on('error', function(info) {
            self.handleReplicationFrom(info, "error");
          })
          .on('complete', function(info) {
            self.handleReplicationFrom(info, "complete");
          });

        return promise;
      }

    };

    service.init();
    return service;
  });
