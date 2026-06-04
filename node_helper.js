const NodeHelper = require("node_helper");
const http = require("http");
const https = require("https");
const url = require("url");

function request(options) {
  return new Promise((resolve, reject) => {
    let uri = options.uri || options.url;
    let parsedUrl = url.parse(uri);
    let isHttps = parsedUrl.protocol === "https:";
    let client = isHttps ? https : http;

    let headers = Object.assign({}, options.headers);
    if (options.body) {
      headers["Content-Length"] = Buffer.byteLength(options.body);
    }

    let reqOptions = {
      method: options.method || "GET",
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.path,
      headers: headers
    };

    let req = client.request(reqOptions, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let body = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          let err = new Error(body);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.setTimeout(options.timeout || 30000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

var debugMe = false;

module.exports = NodeHelper.create({
  start: function() {
    log("Starting helper: " + this.name);
    this.started = false;
  },
  // --------------------------------------- Schedule a stands update
  scheduleUpdate: function(delay) {
    let self = this;
    clearTimeout(self.updatetimer);
    let timeout = delay !== undefined ? delay : 60000;
    self.updatetimer = setTimeout(function() {
      // This timer is saved in uitimer so that we can cancel it
      self.update();
    }, timeout);
  },
  // --------------------------------------- Get Nightscout server configs
  getServerConfig: async function() {
    let self = this;
    return new Promise(resolve => {
      if (self.config.baseUrl) {
        let statusUrl = "/api/v1/status";
        if (self.config.token) {
          statusUrl = statusUrl + "?token=" + self.config.token;
        }
        let options = {
          method: "GET",
          uri: self.config.baseUrl + statusUrl,
          headers: {
            Accept: "application/json"
          }
        };

        request(options)
          .then(function(body) {
            let config = JSON.parse(body);
            debug(
              "getServerConfig: data retrieved, units is " +
                config.settings.units +
                ", status is: " +
                config.status
            );
            resolve(config);
          })
          .catch(function(error) {
            log(
              "getServerConfig: failed when trying to retrieve data: " + error
            );
            reject();
          });
      } else {
        log("getServerConfig: Missing configed base url");
        self.sendSocketNotification(
          "SERVICE_FAILURE",
          "getServerConfig: Missing configed base url"
        );
        reject();
      }
    });
  },
  // --------------------------------------- Get glucose data from Nightscout
  getGlucoseData: async function() {
    let self = this;
    return new Promise(resolve => {
      if (self.config.baseUrl) {
        // *12 since data is updated every 5 minutes, meaning we get 12 values every hour.
        let entriesUrl = "/api/v1/entries.json?count=" + self.config.chartHours*12;

        if (self.config.token) {
          entriesUrl = entriesUrl + "&token=" + self.config.token;
        }
        let options = {
          method: "GET",
          uri:
            self.config.baseUrl +
            entriesUrl
        };

        request(options)
          .then(function(body) {
            let glucoseData = JSON.parse(body);
            debug("getGlucoseData: data retrieved");
            resolve(glucoseData);
          })
          .catch(function(error) {
            log("getGlucoseData: failed when trying to retrieve data: " + error);
            resolve();
          });
      } else {
        log("Missing base url in configuration");
        self.sendSocketNotification(
          "SERVICE_FAILURE",
          "Missing base url in configuration"
        );
        resolve();
      }
    });
  },

  // --------------------------------------- Login to Dexcom Share API
  loginDexcom: async function() {
    let self = this;
    let url = `https://${self.config.server}/ShareWebServices/Services/General/LoginPublisherAccountByName`;
    let options = {
      method: "POST",
      uri: url,
      headers: {
        "User-Agent": DEXCOM_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        accountName: self.config.username,
        password: self.config.password,
        applicationId: DEXCOM_APP_ID
      })
    };
    try {
      let body = await request(options);
      return body.replace(/"/g, "").trim();
    } catch (error) {
      log("loginDexcom: failed to login: " + error);
      self.sendSocketNotification("SERVICE_FAILURE", {
        resp: {
          StatusCode: error.statusCode || 500,
          Message: "Dexcom Login Failed"
        }
      });
      return;
    }
  },

  // --------------------------------------- Fetch glucose data from Dexcom Share API
  getDexcomData: async function(sessionId) {
    let self = this;
    if (!sessionId) return;
    let maxCount = self.config.chartHours * 12;
    let minutes = self.config.chartHours * 60 + 30;
    let url = `https://${self.config.server}/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionID=${sessionId}&minutes=${minutes}&maxCount=${maxCount}`;
    let options = {
      method: "POST",
      uri: url,
      headers: {
        "User-Agent": DEXCOM_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Length": "0"
      }
    };
    try {
      let body = await request(options);
      return JSON.parse(body);
    } catch (error) {
      log("getDexcomData: failed to fetch data: " + error);
      self.sendSocketNotification("SERVICE_FAILURE", {
        resp: {
          StatusCode: error.statusCode || 500,
          Message: "Dexcom Data Fetch Failed"
        }
      });
      return;
    }
  },

  // --------------------------------------- Dexcom specific update loop
  updateDexcom: async function() {
    let self = this;
    clearTimeout(self.updatetimer);

    if (!self.config.username || !self.config.password) {
      log("Missing username or password in configuration for Dexcom");
      self.sendSocketNotification("SERVICE_FAILURE", {
        resp: {
          StatusCode: 400,
          Message: "Dexcom config missing username/password"
        }
      });
      self.scheduleUpdate(30000);
      return;
    }

    if (!self.sessionId) {
      self.sessionId = await self.loginDexcom();
    }

    let nextDelay = 30000; // Default retry is 30 seconds

    if (self.sessionId) {
      let dexcomRaw = await self.getDexcomData(self.sessionId);
      // If data fetch failed, session might have expired. Clear sessionId and retry login/fetch once.
      if (!dexcomRaw) {
        log("Dexcom fetch failed, attempting to re-login...");
        self.sessionId = await self.loginDexcom();
        if (self.sessionId) {
          dexcomRaw = await self.getDexcomData(self.sessionId);
        }
      }

      if (dexcomRaw && dexcomRaw.length > 0) {
        self.glucoseData = dexcomRaw.map(r => {
          let dateMs = Date.now();
          if (r.WT) {
            let match = r.WT.match(/\((.*)\)/);
            if (match && match[1]) {
              dateMs = parseInt(match[1]);
            }
          }
          return {
            sgv: r.Value,
            date: dateMs,
            direction: mapDexcomTrendToDirection(r.Trend),
            trend: r.Trend
          };
        });

        let settings = {
          thresholds: {
            bgHigh: self.config.bgHigh,
            bgLow: self.config.bgLow,
            bgTargetTop: self.config.bgTargetTop,
            bgTargetBottom: self.config.bgTargetBottom
          },
          timeFormat: self.config.timeFormat,
          customTitle: self.config.customTitle
        };

        let units = self.config.units || "mg/dL";
        let dto = generateDto(self.glucoseData, units, settings.thresholds, settings);
        debug(JSON.stringify(dto));
        debug("bs value is: " + dto.bs + " " + dto.unit);
        self.sendSocketNotification("GLUCOSE", dto);

        // Calculate dynamic delay based on the latest reading's timestamp
        let latestTime = self.glucoseData[0].date;
        let nextExpected = latestTime + 300000; // 5 minutes
        let now = Date.now();
        let delay = nextExpected - now;
        if (delay > 0) {
          // Add a 15-second buffer to allow server upload processing
          nextDelay = delay + 15000;
          if (nextDelay > 315000) {
            nextDelay = 315000; // Cap at 5 min 15 sec
          }
          log("Dexcom: Next reading expected in " + Math.round(delay / 1000) + "s. Scheduling update in " + Math.round(nextDelay / 1000) + "s.");
        } else {
          // Overdue reading. Retry in 30 seconds.
          nextDelay = 30000;
          log("Dexcom: Reading is overdue. Retrying in 30s.");
        }
      } else {
        log("Dexcom: No data received or invalid format. Retrying in 30s.");
        nextDelay = 30000;
      }
    } else {
      log("Dexcom: Session ID is missing. Retrying in 30s.");
      nextDelay = 30000;
    }
    self.scheduleUpdate(nextDelay);
  },

  // --------------------------------------- Init
  update: async function() {
    let self = this;
    if (self.config.dataSource === "dexcom") {
      await self.updateDexcom();
      return;
    }
    if (self.config.baseUrl && self.config.server.settings.units) {
      clearTimeout(self.updatetimer); // Clear the timer so that we can set it again
      let glucoseData = await self.getGlucoseData();
      if (glucoseData) {
        self.glucoseData = glucoseData;
        let units = self.config.server.settings.units;
        if (self.config.units) {
          // If unit is set in configuration, overwrite server setting.
          units = self.config.units;
        }
        let dto = generateDto(
          self.glucoseData,
          units,
          self.config.server.settings.thresholds,
          self.config.server.settings
        );
        debug(JSON.stringify(dto));
        debug("bs value is: " + dto.bs + " " + dto.unit);
        self.sendSocketNotification("GLUCOSE", dto); // Send glucose data to presentation layer
      }
      self.scheduleUpdate();
    } else {
      debug("update: missing needed configs");
    }
  },
  // --------------------------------------- Init
  init: async function() {
    let self = this;
    if (self.started) {
      if (self.config.dataSource === "dexcom") {
        await self.update();
      } else if (self.config.baseUrl) {
        self.config.server = await self.getServerConfig();
        await self.update();
      }
    }
  },
  // --------------------------------------- Handle notifications
  socketNotificationReceived: async function(notification, payload) {
    const self = this;
    log("socketNotificationReceived");
    if (notification === "CONFIG") {
      log("CONFIG event received");
      self.config = payload;
      self.debugMe = self.config.debug;
      self.started = true;
      self.init();
    }
  }
});

//Utils
function convertSvgToMmol(sgv) {
  debug("Converting " + sgv + " mg/dL to mmol/L");
  return (Math.round((sgv / 18) * 10) / 10).toFixed(1);
}

function directionToUnicode(direction) {
  switch (direction) {
    case "NONE":
      return "⇼";
    case "DoubleUp":
      return "⇈";
    case "SingleUp":
      return "↑";
    case "FortyFiveUp":
      return "↗";
    case "Flat":
      return "→";
    case "FortyFiveDown":
      return "↘";
    case "SingleDown":
      return "↓";
    case "DoubleDown":
      return "⇊";
    case "RATE OUT OF RANGE":
      return "⇕";
    default:
      return "-";
  }
}

function formatDelta(deltaVal) {
  let num = parseFloat(deltaVal);
  if (num > 0) {
    return "+" + deltaVal;
  }
  return deltaVal.toString();
}

function generateDto(data, unit, thresholds, settings) {
  debug(JSON.stringify(data));
  return {
    bs: unit == "mmol" ? convertSvgToMmol(data[0].sgv) : data[0].sgv,
    delta:
      data.length > 1
        ? (unit == "mmol"
          ? formatDelta(convertSvgToMmol(data[0].sgv - data[1].sgv))
          : formatDelta(data[0].sgv - data[1].sgv))
        : "0",
    unit: unit,
    date: data[0].date,
    trend: data[0].trend,
    direction: directionToUnicode(data[0].direction),
    fontColor: getFontColor(data[0].sgv, thresholds),
    TIR: "TIR: " + getTIR(data, thresholds) + "%",
    thresholds: getThresholds(unit, thresholds),
    data: getCharDataSet(data, unit == "mmol", thresholds),
    settings: settings
  };
}

//
function getFontColor(sgv, thresholds, isChart) {
  if (sgv >= thresholds.bgHigh || sgv <= thresholds.bgLow) {
    return isChart ? "rgb(255, 0, 0)" : "#FF3333";
  }
  if (sgv <= thresholds.bgTargetTop && sgv >= thresholds.bgTargetBottom) {
    return isChart ? "rgb(76, 255, 0)" : "#33FF33";
  }
  return isChart ? "rgb(255, 255, 0)" : "#FFFF33";
}


function getTIR(data, thresholds) {
  log("Getting Time-In-Range");

  let inRange = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i].sgv <= thresholds.bgTargetTop &&
        data[i].sgv >= thresholds.bgTargetBottom) {
      inRange++;
    }
  }
  if (data.length != 0) {
    return Math.floor(1000*inRange/data.length)/10;

  }
  else {
    return 0;
  }
}

function getThresholds(units, thresholds) {
  let bgHigh = thresholds.bgHigh;
  let bgLow = thresholds.bgLow;
  let targetTop = thresholds.bgTargetTop;
  let targetBottom = thresholds.bgTargetBottom;

  if (units == "mmol") {
    bgHigh = convertSvgToMmol(bgHigh);
    bgLow = convertSvgToMmol(bgLow);
    targetTop = convertSvgToMmol(targetTop);
    targetBottom = convertSvgToMmol(targetBottom);
  }

  return {
    bgHigh : bgHigh,
    bgLow : bgLow,
    targetTop : targetTop,
    targetBottom : targetBottom };
}


function getCharDataSet(data, convert, thresholds) {
  debug(
    "getCharDataSet: data set length: " +
      data.length +
      ", convertSvgToMmol:" +
      convert
  );
  let colorSet = [];
  let dataSet = [];
  for (let i = 0; i < data.length; i++) {
    dataSet.push({
      t: data[i].date,
      y: convert ? convertSvgToMmol(data[i].sgv) : data[i].sgv
    });
    colorSet.push(getFontColor(data[i].sgv, thresholds, true));
  }
  return { dataSet: dataSet, colorSet: colorSet };
}

// --------------------------------------- At beginning of log entries
function logStart() {
  return new Date(Date.now()).toLocaleTimeString() + " MMM-Nightscout: ";
}

// --------------------------------------- Logging
function log(msg) {
  console.log(logStart() + msg);
}
// --------------------------------------- Debugging
function debug(msg) {
  if (debugMe) log(msg);
}

const DEXCOM_APP_ID = "d89443d2-327c-4a6f-89e5-496bbb0317db";
const DEXCOM_AGENT = "Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0";

function mapDexcomTrendToDirection(trend) {
  if (trend === undefined || trend === null) return "NONE";
  const mapping = {
    "1": "DoubleUp",
    "2": "SingleUp",
    "3": "FortyFiveUp",
    "4": "Flat",
    "5": "FortyFiveDown",
    "6": "SingleDown",
    "7": "DoubleDown",
    "8": "NONE",
    "9": "RATE OUT OF RANGE",
    "DOUBLEUP": "DoubleUp",
    "SINGLEUP": "SingleUp",
    "FORTYFIVEUP": "FortyFiveUp",
    "FLAT": "Flat",
    "FORTYFIVEDOWN": "FortyFiveDown",
    "SINGLEDOWN": "SingleDown",
    "DOUBLEDOWN": "DoubleDown",
    "NONE": "NONE",
    "NOT COMPUTABLE": "NONE",
    "RATE OUT OF RANGE": "RATE OUT OF RANGE"
  };
  const key = trend.toString().toUpperCase().trim();
  return mapping[key] || "NONE";
}
