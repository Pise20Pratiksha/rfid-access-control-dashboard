// ============================================================
//  DUAL RFID GATE LOGGER with Seamless Device-to-Device (D2D)
//  Local Wi-Fi Communication & Automatic Discovery
//  Hardware : ESP32
//             + 2x CF000749 UHF modules (IN / OUT UART)
//             + DS3231 RTC (I2C)
//             + ILI9341 TFT (SPI)
//             + Optional Gate Relay (GPIO 32)
//
//  Key Features:
//    - Zero Internet Access Required: Purely local router D2D communication
//    - Permanent Unique Device ID: Derived from factory eFuse MAC address
//    - Automatic Discovery: Non-blocking UDP broadcast + mDNS resolution
//    - Dynamic IP Resolution: Adapts automatically to DHCP renewals on both
//      the ESP32 and the application server without restarts
//    - Secure Device Authentication: Pre-shared key handshake & message validation
//    - Reliable Bidirectional TCP: Real-time scan transfer, instant auth feedback
//      (green/red screen + gate trigger), remote commands, RTC time sync
//    - Resilient Reconnection: Wi-Fi disconnect recovery, dead-socket watchdog
//    - Offline NVS Storage: Circular buffer with verified synchronization
// ============================================================

#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <SPI.h>
#include <HardwareSerial.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Wire.h>
#include <RTClib.h>
#include <Preferences.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiUdp.h>
#include <WebServer.h>

// ─────────────────────────────────────────────────────────────
//  CONNECTION MODE
//  0 = LAN only   : UDP + mDNS discovery, raw TCP to the local server
//  1 = CLOUD only : wss://CLOUD_HOST/api/device-ws (works from any Wi-Fi)
//  2 = AUTO       : try the local LAN server first, fall back to the cloud
//                   when it is not found (recommended: works at home AND away)
//  Modes 1 and 2 need the Arduino library "WebSockets" by Markus Sattler (2.4+).
// ─────────────────────────────────────────────────────────────
#define CLOUD_MODE 2
#define LAN_PROBES_BEFORE_CLOUD 3   // ~6 s of failed LAN discovery, then use cloud
#if CLOUD_MODE
  #include <WebSocketsClient.h>
  #define CLOUD_HOST "rfid-access-control.onrender.com"   // no https://, no trailing slash
  #define CLOUD_PORT 443
  #define CLOUD_PATH "/api/device-ws"
  // Optional: pin the server's root CA (PEM string) to stop man-in-the-middle.
  // Needs a correct clock, so only enable once the RTC/NTP time is reliable.
  // #define CLOUD_ROOT_CA "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
#endif

// ─────────────────────────────────────────────────────────────
//  DEBUG OUTPUT
// ─────────────────────────────────────────────────────────────
#define DEBUG 1
#if DEBUG
  #define DBG(x)   Serial.print(x)
  #define DBGLN(x) Serial.println(x)
#else
  #define DBG(x)
  #define DBGLN(x)
#endif

// ─────────────────────────────────────────────────────────────
//  PIN DEFINITIONS
// ─────────────────────────────────────────────────────────────
#define TFT_CS         5
#define TFT_DC         2
#define TFT_RST        4

#define UHF_IN_RX      16
#define UHF_IN_TX      17
#define UHF_OUT_RX     25
#define UHF_OUT_TX     26

// Optional Relay output for gate barrier motor (set to -1 if unused)
#define GATE_RELAY_PIN 32
#define RELAY_ACTIVE_LOW 0 // 1 if relay module is active LOW, 0 if active HIGH

// ─────────────────────────────────────────────────────────────
//  TUNING CONSTANTS
// ─────────────────────────────────────────────────────────────
const byte          TX_POWER_DBM = 30;
const unsigned long INVENTORY_MS = 600;
const unsigned long DEDUP_MS     = 300000UL; // 5 minutes duplicate filter

// ─────────────────────────────────────────────────────────────
//  NETWORK CONFIGURATION (Wi-Fi + Hostname + TCP + Auth)
// ─────────────────────────────────────────────────────────────
// Wi-Fi Station credentials (SPJ Wi-Fi Router)
const char* WIFI_SSID = "spjetpl";
const char* WIFI_PASS = "spjetplpune123";

// Fallback SoftAP credentials if router is unreachable
const char* AP_SSID = "GateLogger";
const char* AP_PASS = "logger123";
IPAddress   AP_IP(192, 168, 4, 1);
IPAddress   AP_GATEWAY(192, 168, 4, 1);
IPAddress   AP_SUBNET(255, 255, 255, 0);

// Hostname of the application server (mDNS / Local DNS)
const char* APP_HOSTNAME          = "rfid-app.local";

// Fixed TCP server port on the backend application
const uint16_t TCP_SERVER_PORT    = 5001;

// UDP Discovery port for local broadcast discovery and beacon reception
const uint16_t UDP_DISCOVERY_PORT = 5002;

// Secure pre-shared authentication key (must equal the server's DEVICE_AUTH_SECRET).
// Replace with the secret you set on Render before flashing; never commit the real value.
const char* DEVICE_AUTH_KEY       = "CHANGE_ME_DEVICE_AUTH_SECRET";

// Timers and intervals
const unsigned long DISCOVERY_PROBE_INTERVAL_MS = 2000;  // Probe every 2s during discovery
const unsigned long TCP_RETRY_INTERVAL_MS       = 3000;  // Retry connect every 3s
const unsigned long TCP_PING_INTERVAL_MS        = 15000; // Ping every 15s
const unsigned long TCP_RX_TIMEOUT_MS           = 45000; // 45s without data = dead socket
const unsigned long RELAY_PULSE_DURATION_MS     = 2500;  // Gate open pulse length

// ─────────────────────────────────────────────────────────────
//  PERMANENT DEVICE IDENTIFICATION
// ─────────────────────────────────────────────────────────────
String permanentDeviceId = "";
String deviceMacAddress  = "";

String getPermanentDeviceId() {
  if (permanentDeviceId.length() > 0) return permanentDeviceId;
  uint64_t chipId = ESP.getEfuseMac();
  char idBuf[32];
  snprintf(idBuf, sizeof(idBuf), "ESP32-GATE-%04X%08X", (uint16_t)(chipId >> 32), (uint32_t)chipId);
  permanentDeviceId = String(idBuf);
  return permanentDeviceId;
}

// ─────────────────────────────────────────────────────────────
//  NETWORK STATE MACHINE
// ─────────────────────────────────────────────────────────────
enum NetState {
  STATE_WIFI_DISCONNECTED,
  STATE_DISCOVERING_SERVER,
  STATE_CONNECTING_TCP,
  STATE_AUTHENTICATING,
  STATE_CONNECTED
};

NetState      netState                 = STATE_WIFI_DISCONNECTED;
IPAddress     serverIP;
uint16_t      serverPort               = TCP_SERVER_PORT;
bool          hostnameResolved         = false;
bool          isAuthenticated          = false;
IPAddress     lastKnownLocalIP;

unsigned long lastWifiCheckMs          = 0;
unsigned long lastDiscoveryAttemptMs   = 0;
unsigned long lastTcpAttemptMs         = 0;
unsigned long lastAuthAttemptMs        = 0;
unsigned long lastPingSentMs           = 0;
unsigned long lastServerRxMs           = 0;
unsigned long relayOffAtMs             = 0;
bool          relayActive              = false;

int           tcpConnectFailCount      = 0;
int           resolveFailCount         = 0;

String        ipString                 = "0.0.0.0";
String        networkStatusText        = "Booting...";

// ─────────────────────────────────────────────────────────────
//  NVS CIRCULAR BUFFER
// ─────────────────────────────────────────────────────────────
#define MAX_RECORDS   500
#define NVS_NAMESPACE "rfidlog"

Preferences nvs;
uint32_t    nvsHead  = 0;
uint32_t    nvsTail  = 0;
uint32_t    nvsCount = 0;

#define REC_KEY_LEN 12

void nvsKeyForIndex(uint32_t idx, char* buf) {
  snprintf(buf, REC_KEY_LEN, "rec_%04lu", (unsigned long)(idx % MAX_RECORDS));
}

void nvsLoadMeta() {
  nvs.begin(NVS_NAMESPACE, false);
  nvsHead  = nvs.getUInt("head",  0);
  nvsTail  = nvs.getUInt("tail",  0);
  nvsCount = nvs.getUInt("count", 0);
  nvs.end();
  DBG("NVS loaded — count="); DBGLN(nvsCount);
}

void nvsSaveMeta() {
  nvs.begin(NVS_NAMESPACE, false);
  nvs.putUInt("head",  nvsHead);
  nvs.putUInt("tail",  nvsTail);
  nvs.putUInt("count", nvsCount);
  nvs.end();
}

void nvsWriteRecord(const String& epc,
                    const String& date,
                    const String& time,
                    const char*   direction) {
  char key[REC_KEY_LEN];
  nvsKeyForIndex(nvsHead, key);
  String rec = epc + "," + date + "," + time + "," + direction;
  nvs.begin(NVS_NAMESPACE, false);
  nvs.putString(key, rec);
  nvs.end();
  nvsHead = (nvsHead + 1) % MAX_RECORDS;
  if (nvsCount < MAX_RECORDS) {
    nvsCount++;
  } else {
    nvsTail = (nvsTail + 1) % MAX_RECORDS;
  }
  nvsSaveMeta();
  DBG("NVS wrote ["); DBG(key); DBG("]: "); DBGLN(rec);
}

String nvsReadRecord(uint32_t pos) {
  if (pos >= nvsCount) return "";
  uint32_t idx = (nvsTail + pos) % MAX_RECORDS;
  char key[REC_KEY_LEN];
  nvsKeyForIndex(idx, key);
  nvs.begin(NVS_NAMESPACE, true);
  String rec = nvs.getString(key, "");
  nvs.end();
  return rec;
}

void nvsClearAll() {
  nvs.begin(NVS_NAMESPACE, false);
  nvs.clear();
  nvs.end();
  nvsHead = nvsTail = nvsCount = 0;
  DBGLN("[NVS] Cleared all local records.");
}

// ─────────────────────────────────────────────────────────────
//  DEDUP TABLE
// ─────────────────────────────────────────────────────────────
#define MAX_TAGS 20

struct TagRecord {
  String        epc;
  unsigned long lastSeen;
};

TagRecord seenTagsIN[MAX_TAGS];
int       seenTagCountIN  = 0;
TagRecord seenTagsOUT[MAX_TAGS];
int       seenTagCountOUT = 0;

bool isNewTag(const String& epc, TagRecord* table, int& count) {
  unsigned long now = millis();
  for (int i = 0; i < count; i++) {
    if (table[i].epc == epc) {
      if (now - table[i].lastSeen < DEDUP_MS) return false;
      table[i].lastSeen = now;
      return true;
    }
  }
  if (count < MAX_TAGS) {
    table[count].epc      = epc;
    table[count].lastSeen = now;
    count++;
  } else {
    int oldest = 0;
    for (int i = 1; i < MAX_TAGS; i++)
      if (table[i].lastSeen < table[oldest].lastSeen) oldest = i;
    table[oldest].epc      = epc;
    table[oldest].lastSeen = now;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
//  GLOBAL HARDWARE & NETWORKING OBJECTS
// ─────────────────────────────────────────────────────────────
Adafruit_ILI9341 tft = Adafruit_ILI9341(TFT_CS, TFT_DC, TFT_RST);
HardwareSerial   uhfIN(2);
HardwareSerial   uhfOUT(1);
RTC_DS3231       rtc;

WiFiUDP          udpDiscovery;
#if CLOUD_MODE
bool    cloudFallback = false;   // true = current session goes through the cloud
uint8_t lanProbeCount = 0;

// Drop-in replacement for WiFiClient. Same newline-delimited JSON protocol,
// carried either over raw TCP (LAN) or one message per WebSocket text frame
// over TLS (wss://, cloud) depending on cloudFallback.
class HybridClient {
public:
  bool connect(IPAddress ip, uint16_t port) {
    _rx = ""; _out = ""; _up = false;
    _cloud = (CLOUD_MODE == 1) || cloudFallback;
    if (!_cloud) return _tcp.connect(ip, port);
#ifdef CLOUD_ROOT_CA
    _ws.beginSslWithCA(CLOUD_HOST, CLOUD_PORT, CLOUD_PATH, CLOUD_ROOT_CA);
#else
    _ws.beginSSL(CLOUD_HOST, CLOUD_PORT, CLOUD_PATH);
#endif
    _ws.onEvent([this](WStype_t type, uint8_t* payload, size_t length) {
      if (type == WStype_CONNECTED) {
        _up = true;
        DBGLN("[Cloud] WebSocket connected");
      } else if (type == WStype_DISCONNECTED) {
        if (_up) DBGLN("[Cloud] WebSocket disconnected");
        _up = false;
      } else if (type == WStype_ERROR) {
        DBGLN("[Cloud] WebSocket error (check CLOUD_HOST / internet / TLS)");
      } else if (type == WStype_TEXT) {
        _rx += String((const char*)payload).substring(0, length);
        _rx += "\n";
      }
    });
    _ws.setReconnectInterval(5000);
    _ws.enableHeartbeat(15000, 5000, 2);   // WS ping/pong keeps NAT + proxy alive
    unsigned long start = millis();
    while (!_up && millis() - start < 8000) { _ws.loop(); delay(10); }
    return _up;
  }
  void setNoDelay(bool v) { if (!_cloud) _tcp.setNoDelay(v); }
  bool connected() {
    if (!_cloud) return _tcp.connected();
    _ws.loop();
    return _up;
  }
  int available() {
    if (!_cloud) return _tcp.available();
    _ws.loop();
    return _rx.length();
  }
  String readStringUntil(char term) {
    if (!_cloud) return _tcp.readStringUntil(term);
    int nl = _rx.indexOf('\n');
    if (nl < 0) { String all = _rx; _rx = ""; return all; }
    String line = _rx.substring(0, nl);
    _rx.remove(0, nl + 1);
    return line;
  }
  size_t print(const String& s) {
    if (!_cloud) return _tcp.print(s);
    _out += s;
    if (_out.endsWith("\n")) flush();
    return s.length();
  }
  size_t print(const char* s) { return print(String(s)); }
  void flush() {
    if (!_cloud) { _tcp.flush(); return; }
    if (_out.length() && _up) _ws.sendTXT(_out);
    _out = "";
  }
  void stop() {
    _tcp.stop();
    if (_cloud) _ws.disconnect();
    _up = false; _rx = ""; _out = "";
  }
  explicit operator bool() { return connected(); }
private:
  WiFiClient       _tcp;
  WebSocketsClient _ws;
  String _rx, _out;
  bool   _up    = false;
  bool   _cloud = false;
};
HybridClient     tcpClient;
#else
WiFiClient       tcpClient;
#endif
WebServer        server(80);

int              totalDetect         = 0;
bool             tagScreenActive     = false;
bool             idleNeedsFullRedraw = false;

// ─────────────────────────────────────────────────────────────
//  CRC16 HELPER
// ─────────────────────────────────────────────────────────────
unsigned int crc16(byte* p, unsigned int len) {
  unsigned int crc = 0xFFFF;
  for (unsigned int i = 0; i < len; i++) {
    crc ^= p[i];
    for (byte j = 0; j < 8; j++)
      crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : (crc >> 1);
  }
  return crc;
}

// ─────────────────────────────────────────────────────────────
//  UHF HARDWARE COMMANDS
// ─────────────────────────────────────────────────────────────
void sendCmd(HardwareSerial& port, byte* cmd, byte len) {
  unsigned int c = crc16(cmd, len);
  port.write(cmd, len);
  port.write((c >> 8) & 0xFF);
  port.write(c & 0xFF);
}

void flushPort(HardwareSerial& port) {
  delay(20);
  while (port.available()) port.read();
}

void setTxPower(HardwareSerial& port, byte dBm) {
  if (dBm < 26) dBm = 26;
  if (dBm > 30) dBm = 30;
  unsigned int val = (unsigned int)dBm * 100;
  byte cmd[] = {
    0xCF, 0xFF, 0x00, 0x06, 0x04,
    0x00, 0x00, 0x00, 0x00,
    (byte)(val & 0xFF), (byte)(val >> 8)
  };
  sendCmd(port, cmd, sizeof(cmd));
  delay(150);
  flushPort(port);
}

void sendInventory(HardwareSerial& port) {
  byte cmd[] = {0xCF, 0xFF, 0x00, 0x01, 0x05,
                0x00, 0x00, 0x00, 0x00, 0x00};
  sendCmd(port, cmd, sizeof(cmd));
}

void sendStopInventory(HardwareSerial& port) {
  byte cmd[] = {0xCF, 0xFF, 0x00, 0x02, 0x00};
  sendCmd(port, cmd, sizeof(cmd));
}

String readOneEPCFrame(HardwareSerial& port, unsigned long windowEnd) {
  while (millis() < windowEnd) {
    if (port.available() < 4) { delay(2); continue; }
    if (port.read() != 0xCF) continue;
    if (port.read() != 0xFF) continue;

    int lenH = port.read();
    int lenL = port.read();
    if (lenH < 0 || lenL < 0) continue;
    int payloadLen = (lenH << 8) | lenL;
    if (payloadLen <= 0 || payloadLen > 64) continue;

    byte buf[64];
    int readBytes = port.readBytes(buf, payloadLen);
    if (readBytes < payloadLen) continue;

    byte crcBytes[2];
    if (port.readBytes(crcBytes, 2) < 2) continue;

    if (payloadLen > 8) {
      char hex[64];
      int  hexIdx = 0;
      for (int i = 8; i < payloadLen; i++) {
        snprintf(hex + hexIdx, 3, "%02X", buf[i]);
        hexIdx += 2;
      }
      hex[hexIdx] = '\0';
      return String(hex);
    }
  }
  return "";
}

String runInventoryBurst(HardwareSerial& port) {
  flushPort(port);
  sendInventory(port);
  unsigned long windowEnd = millis() + INVENTORY_MS;
  String epc = readOneEPCFrame(port, windowEnd);
  sendStopInventory(port);
  unsigned long st = millis();
  while (millis() - st < 80) {
    if (port.available()) port.read();
  }
  return epc;
}

// ─────────────────────────────────────────────────────────────
//  GATE RELAY CONTROL
// ─────────────────────────────────────────────────────────────
void triggerGateRelay() {
  if (GATE_RELAY_PIN < 0) return;
  DBGLN("[RELAY] Triggering gate barrier open pulse...");
  digitalWrite(GATE_RELAY_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);
  relayActive = true;
  relayOffAtMs = millis() + RELAY_PULSE_DURATION_MS;
}

void serviceRelay() {
  if (relayActive && millis() >= relayOffAtMs) {
    if (GATE_RELAY_PIN >= 0) {
      digitalWrite(GATE_RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
    }
    relayActive = false;
    DBGLN("[RELAY] Gate pulse ended, relay de-energized.");
  }
}

// ─────────────────────────────────────────────────────────────
//  DATE & TIME HELPERS
// ─────────────────────────────────────────────────────────────
String getDateString() {
  DateTime now = rtc.now();
  char buf[12];
  snprintf(buf, sizeof(buf), "%02d/%02d/%04d", now.day(), now.month(), now.year());
  return String(buf);
}

String getTimeString() {
  DateTime now = rtc.now();
  char buf[10];
  snprintf(buf, sizeof(buf), "%02d:%02d:%02d", now.hour(), now.minute(), now.second());
  return String(buf);
}

bool applyDateTime(const String& ts) {
  if (ts.length() < 19) return false;

  int d  = ts.substring(0,  2).toInt();
  int mo = ts.substring(3,  5).toInt();
  int y  = ts.substring(6,  10).toInt();
  int h  = ts.substring(11, 13).toInt();
  int mi = ts.substring(14, 16).toInt();
  int s  = ts.substring(17, 19).toInt();

  if (y < 2020 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    DBGLN("[RTC] Invalid datetime values");
    return false;
  }

  rtc.adjust(DateTime(y, mo, d, h, mi, s));
  DBG("[RTC] Datetime synchronized to: "); DBGLN(ts);
  idleNeedsFullRedraw = true;
  return true;
}

void handleRTCSet() {
  unsigned long flush = millis();
  while (millis() - flush < 100) {
    if (Serial.available()) Serial.read();
    delay(1);
  }
  Serial.println("Send datetime in format: DD/MM/YYYY HH:MM:SS (e.g. 15/10/2026 16:30:00)");
  unsigned long wait = millis();
  while (!Serial.available() && millis() - wait < 10000) delay(10);
  if (!Serial.available()) {
    Serial.println("Timeout.");
    return;
  }
  String ts = Serial.readStringUntil('\n');
  ts.trim();
  if (applyDateTime(ts)) {
    Serial.println("RTC set successfully!");
  } else {
    Serial.println("Failed to set RTC.");
  }
}

// ─────────────────────────────────────────────────────────────
//  LIGHTWEIGHT ROBUST JSON PARSER HELPERS
// ─────────────────────────────────────────────────────────────
String extractJsonString(const String& json, const String& key) {
  String target = "\"" + key + "\"";
  int keyIndex = json.indexOf(target);
  if (keyIndex == -1) return "";

  int colonIndex = json.indexOf(':', keyIndex + target.length());
  if (colonIndex == -1) return "";

  int quoteStart = json.indexOf('\"', colonIndex + 1);
  if (quoteStart == -1) return "";

  int quoteEnd = json.indexOf('\"', quoteStart + 1);
  if (quoteEnd == -1) return "";

  return json.substring(quoteStart + 1, quoteEnd);
}

int extractJsonInt(const String& json, const String& key, int defaultVal = 0) {
  String target = "\"" + key + "\"";
  int keyIndex = json.indexOf(target);
  if (keyIndex == -1) return defaultVal;

  int colonIndex = json.indexOf(':', keyIndex + target.length());
  if (colonIndex == -1) return defaultVal;

  int i = colonIndex + 1;
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;

  int numStart = i;
  while (i < (int)json.length() && (isDigit(json[i]) || json[i] == '-')) i++;

  if (numStart == i) return defaultVal;
  return json.substring(numStart, i).toInt();
}

bool extractJsonBool(const String& json, const String& key, bool defaultVal = false) {
  String target = "\"" + key + "\"";
  int keyIndex = json.indexOf(target);
  if (keyIndex == -1) return defaultVal;

  int colonIndex = json.indexOf(':', keyIndex + target.length());
  if (colonIndex == -1) return defaultVal;

  String rest = json.substring(colonIndex + 1);
  rest.trim();
  if (rest.startsWith("true")) return true;
  if (rest.startsWith("false")) return false;
  return defaultVal;
}

String recordToJSON(const String& rec, uint32_t idx) {
  int c1 = rec.indexOf(',');
  int c2 = rec.indexOf(',', c1 + 1);
  int c3 = rec.indexOf(',', c2 + 1);
  if (c1 < 0 || c2 < 0 || c3 < 0) return "";

  String epc  = rec.substring(0, c1);
  String date = rec.substring(c1 + 1, c2);
  String time = rec.substring(c2 + 1, c3);
  String dir  = rec.substring(c3 + 1);

  return "{\"idx\":" + String(idx) +
         ",\"epc\":\""  + epc  + "\"" +
         ",\"date\":\"" + date + "\"" +
         ",\"time\":\"" + time + "\"" +
         ",\"dir\":\""  + dir  + "\"}";
}

// ─────────────────────────────────────────────────────────────
//  DYNAMIC ASYNCHRONOUS DEVICE DISCOVERY (UDP + mDNS)
// ─────────────────────────────────────────────────────────────

// Non-blocking UDP packet listener: services incoming server beacons & responses
void serviceIncomingUDPDiscovery() {
  int packetSize = udpDiscovery.parsePacket();
  if (packetSize <= 0) return;

  char buf[512];
  int len = udpDiscovery.read(buf, sizeof(buf) - 1);
  if (len <= 0) return;
  buf[len] = '\0';
  String msg = String(buf);

  String hostStr = extractJsonString(msg, "host");
  int    portNum = extractJsonInt(msg, "tcpPort", TCP_SERVER_PORT);
  String type    = extractJsonString(msg, "type");

  if (hostStr.length() > 0) {
    IPAddress parsedIP;
    if (parsedIP.fromString(hostStr)) {
      bool ipChanged = (parsedIP != serverIP);
      serverIP = parsedIP;
      serverPort = portNum > 0 ? portNum : TCP_SERVER_PORT;
      hostnameResolved = true;

      if (ipChanged) {
        DBG("[Discovery] Discovered/Updated Server IP via UDP: ");
        DBG(serverIP.toString()); DBG(":"); DBGLN(serverPort);

        // If currently connected or trying to connect to a stale IP, trigger reconnect
        if (netState == STATE_CONNECTED || netState == STATE_CONNECTING_TCP || netState == STATE_AUTHENTICATING) {
          DBGLN("[Discovery] Server IP changed dynamically (DHCP update). Reconnecting TCP...");
          tcpClient.stop();
          isAuthenticated = false;
          netState = STATE_CONNECTING_TCP;
          lastTcpAttemptMs = 0;
          idleNeedsFullRedraw = true;
        }
      }

      if (netState == STATE_DISCOVERING_SERVER) {
        netState = STATE_CONNECTING_TCP;
        lastTcpAttemptMs = 0;
        networkStatusText = "Found Server";
        idleNeedsFullRedraw = true;
      }
    }
  }
}

// Sends active discovery probe broadcast
void sendDiscoveryProbeUDP() {
  if (WiFi.status() != WL_CONNECTED) return;

#if CLOUD_MODE == 1
  // Cloud only: the server is a fixed public hostname, nothing to discover.
  hostnameResolved = true;
  networkStatusText = "Cloud Server";
  netState = STATE_CONNECTING_TCP;
  lastTcpAttemptMs = 0;
  idleNeedsFullRedraw = true;
  return;
#elif CLOUD_MODE == 2
  // Auto: probe the LAN a few times; if no local server answers, use the cloud.
  if (cloudFallback || ++lanProbeCount > LAN_PROBES_BEFORE_CLOUD) {
    cloudFallback = true;
    hostnameResolved = true;
    networkStatusText = "Cloud Server";
    netState = STATE_CONNECTING_TCP;
    lastTcpAttemptMs = 0;
    idleNeedsFullRedraw = true;
    DBGLN("[Discovery] No LAN server found, using cloud server");
    return;
  }
#endif

  DBG("[Discovery] Broadcasting UDP probe to 255.255.255.255:"); DBGLN(UDP_DISCOVERY_PORT);
  udpDiscovery.beginPacket(IPAddress(255, 255, 255, 255), UDP_DISCOVERY_PORT);
  String probe = "{\"type\":\"discovery_probe\",\"deviceId\":\"" + getPermanentDeviceId() +
                 "\",\"name\":\"ESP32 Gate Logger\",\"mac\":\"" + deviceMacAddress +
                 "\",\"ip\":\"" + ipString + "\",\"version\":\"2.1.0\",\"nvsCount\":" +
                 String(nvsCount) + "}\n";
  udpDiscovery.print(probe);
  udpDiscovery.endPacket();

  // Also query mDNS hostname quickly without blocking
  String cleanName = String(APP_HOSTNAME);
  if (cleanName.endsWith(".local")) {
    cleanName = cleanName.substring(0, cleanName.length() - 6);
  }
  IPAddress mdnsIP = MDNS.queryHost(cleanName.c_str(), 200);
  if (mdnsIP != INADDR_NONE && mdnsIP != IPAddress(0, 0, 0, 0)) {
    serverIP = mdnsIP;
    serverPort = TCP_SERVER_PORT;
    hostnameResolved = true;
    netState = STATE_CONNECTING_TCP;
    lastTcpAttemptMs = 0;
    DBG("[mDNS] Resolved hostname '"); DBG(cleanName); DBG("' -> "); DBGLN(serverIP.toString());
  }
}

// ─────────────────────────────────────────────────────────────
//  TCP CLIENT & BIDIRECTIONAL PROTOCOL
// ─────────────────────────────────────────────────────────────

void sendAuthRequest() {
  if (!tcpClient || !tcpClient.connected()) return;

  String authMsg = "{\"type\":\"auth_request\",\"deviceId\":\"" + getPermanentDeviceId() +
                   "\",\"name\":\"ESP32 Gate Logger\",\"token\":\"" + String(DEVICE_AUTH_KEY) +
                   "\",\"mac\":\"" + deviceMacAddress + "\",\"ip\":\"" + ipString +
                   "\",\"version\":\"2.1.0\",\"nvsCount\":" + String(nvsCount) + "}\n";
  tcpClient.print(authMsg);
  tcpClient.flush();
  DBG("[TCP TX] Sent auth_request for "); DBGLN(getPermanentDeviceId());
}

void attemptTCPConnect() {
  if (WiFi.status() != WL_CONNECTED || !hostnameResolved) {
    netState = STATE_DISCOVERING_SERVER;
    return;
  }

#if CLOUD_MODE
  if (CLOUD_MODE == 1 || cloudFallback) {
    DBG("[Cloud] Connecting to wss://"); DBG(CLOUD_HOST); DBGLN(CLOUD_PATH);
  } else
#endif
  {
    DBG("[TCP] Connecting to ");
    DBG(serverIP.toString());
    DBG(":");
    DBG(serverPort);
    DBGLN("...");
  }

  tcpClient.stop();
  if (tcpClient.connect(serverIP, serverPort)) {
    tcpClient.setNoDelay(true);
    netState = STATE_AUTHENTICATING;
    isAuthenticated = false;
    tcpConnectFailCount = 0;
    resolveFailCount = 0;
#if CLOUD_MODE == 2
    if (!cloudFallback) lanProbeCount = 0;   // LAN works: keep preferring it
#endif
    lastPingSentMs = millis();
    lastServerRxMs = millis();
    lastAuthAttemptMs = millis();

    DBG("[TCP] Connected to "); DBGLN(serverIP.toString());

    // Step 1: Send secure authentication handshake
    sendAuthRequest();

    networkStatusText = "Authenticating...";
    idleNeedsFullRedraw = true;
  } else {
    tcpConnectFailCount++;
    DBG("[TCP] Connect failed, attempt "); DBGLN(tcpConnectFailCount);

    // If connect repeatedly fails, server IP might have changed on DHCP router
    if (tcpConnectFailCount >= 3) {
      DBGLN("[TCP] Connect retries exceeded. Re-discovering server...");
      hostnameResolved = false;
      tcpConnectFailCount = 0;
      netState = STATE_DISCOVERING_SERVER;
      lastDiscoveryAttemptMs = 0;
      networkStatusText = "Re-discovering...";
      idleNeedsFullRedraw = true;
    }
  }
}

void sendHistoricalDumpTCP() {
  if (!tcpClient || !tcpClient.connected()) return;

  DBG("[TCP] Streaming "); DBG(nvsCount); DBGLN(" historical records to server...");
  tcpClient.print("{\"type\":\"sync_response\",\"records\":[");
  bool first = true;
  for (uint32_t i = 0; i < nvsCount; i++) {
    String rec = nvsReadRecord(i);
    String rj  = recordToJSON(rec, i);
    if (rj.length() == 0) continue;
    if (!first) tcpClient.print(",");
    tcpClient.print(rj);
    first = false;
    yield();
  }
  tcpClient.print("]}\n");
  tcpClient.flush();
  DBGLN("[TCP] Historical records sync sent.");
}

void handleServerMessage(const String& line) {
  DBG("[TCP RX] "); DBGLN(line);

  String type   = extractJsonString(line, "type");
  String status = extractJsonString(line, "status");
  String cmd    = extractJsonString(line, "cmd");

  // 1. Authentication Handshake Response
  if (type == "auth_response") {
    if (status == "authenticated") {
      isAuthenticated = true;
      netState = STATE_CONNECTED;
      networkStatusText = "Online (Auth OK)";
      idleNeedsFullRedraw = true;
      DBGLN("[TCP] Device authenticated successfully by server!");

      // Sync time if server provided it
      String sTime = extractJsonString(line, "serverTime");
      if (sTime.length() >= 19 && extractJsonBool(line, "syncTime", true)) {
        applyDateTime(sTime);
      }
    } else {
      DBGLN("[TCP] Authentication rejected by server! DEVICE_AUTH_KEY must equal the server's DEVICE_AUTH_SECRET.");
      networkStatusText = "Auth Failed";
      idleNeedsFullRedraw = true;
      tcpClient.stop();
      isAuthenticated = false;
      netState = STATE_DISCOVERING_SERVER;
    }
    return;
  }

  // 2. Real-time Authorization Feedback from Tag Scan
  if (type == "auth_result") {
    bool   authorized  = extractJsonBool(line, "authorized", false);
    String plateNumber = extractJsonString(line, "plateNumber");
    String ownerName   = extractJsonString(line, "ownerName");
    String action      = extractJsonString(line, "action");

    // Trigger physical gate barrier relay if authorized
    if (authorized || action == "open_gate") {
      triggerGateRelay();
    }

    if (tagScreenActive) {
      tft.fillRect(10, 215, 300, 25, ILI9341_BLACK);
      tft.setFont(&FreeSansBold12pt7b);
      if (authorized) {
        tft.setTextColor(ILI9341_GREEN);
        tft.setCursor(10, 235);
        tft.print("GRANTED: ");
        tft.print(plateNumber.length() > 0 ? plateNumber : "AUTHORIZED");
      } else {
        tft.setTextColor(ILI9341_RED);
        tft.setCursor(10, 235);
        tft.print("DENIED: UNREGISTERED");
      }
    }
    return;
  }

  // 3. Dump Offline Records Request
  if (cmd == "dump") {
    sendHistoricalDumpTCP();
    return;
  }

  // 4. Clear Synchronized Records
  if (cmd == "clear") {
    nvsClearAll();
    totalDetect = 0;
    idleNeedsFullRedraw = true;
    tcpClient.print("{\"type\":\"cmd_ack\",\"cmd\":\"clear\",\"status\":\"ok\"}\n");
    return;
  }

  // 5. Remote Gate Barrier Trigger
  if (cmd == "open_gate") {
    triggerGateRelay();
    tcpClient.print("{\"type\":\"cmd_ack\",\"cmd\":\"open_gate\",\"status\":\"ok\"}\n");
    return;
  }

  // 6. Remote RTC Time Sync
  if (cmd == "set_time") {
    String dt = extractJsonString(line, "datetime");
    if (applyDateTime(dt)) {
      tcpClient.print("{\"type\":\"cmd_ack\",\"cmd\":\"set_time\",\"status\":\"ok\"}\n");
    } else {
      tcpClient.print("{\"type\":\"cmd_ack\",\"cmd\":\"set_time\",\"status\":\"error\"}\n");
    }
    return;
  }

  // 7. Remote Reboot Command
  if (cmd == "reboot") {
    tcpClient.print("{\"type\":\"cmd_ack\",\"cmd\":\"reboot\",\"status\":\"ok\"}\n");
    tcpClient.flush();
    delay(500);
    ESP.restart();
    return;
  }

  // 8. Connection ACK (legacy fallback)
  if (type == "ack") {
    String sTime = extractJsonString(line, "serverTime");
    if (sTime.length() >= 19 && extractJsonBool(line, "syncTime", false)) {
      applyDateTime(sTime);
    }
    return;
  }

  // 9. Keepalive Pong
  if (type == "pong") {
    return;
  }
}

void serviceTCPClient() {
  if (!tcpClient.connected()) {
    DBGLN("[TCP] Disconnected from server. Re-discovering in case IP changed...");
    tcpClient.stop();
    isAuthenticated = false;
    hostnameResolved = false;
    netState = STATE_DISCOVERING_SERVER;
    networkStatusText = "Re-discovering";
    idleNeedsFullRedraw = true;
    lastDiscoveryAttemptMs = 0;
    return;
  }

  // Read incoming server data stream
  while (tcpClient.available()) {
    String line = tcpClient.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) {
      lastServerRxMs = millis();
      handleServerMessage(line);
    }
  }

  unsigned long now = millis();

  // If in authenticating state, re-send auth if no response in 5s
  if (netState == STATE_AUTHENTICATING && !isAuthenticated) {
    if (now - lastAuthAttemptMs >= 5000) {
      lastAuthAttemptMs = now;
      sendAuthRequest();
    }
  }

  // Periodic keepalive ping (every 15s)
  if (netState == STATE_CONNECTED && now - lastPingSentMs >= TCP_PING_INTERVAL_MS) {
    lastPingSentMs = now;
    String pingPacket = "{\"type\":\"ping\",\"deviceId\":\"" + getPermanentDeviceId() +
                        "\",\"uptime\":" + String(now / 1000) + "}\n";
    tcpClient.print(pingPacket);
    tcpClient.flush();
  }

  // Dead socket watchdog (45s without data from server)
  if (now - lastServerRxMs >= TCP_RX_TIMEOUT_MS) {
    DBGLN("[TCP] Keepalive timeout! Tearing down half-open socket and re-discovering...");
    tcpClient.stop();
    isAuthenticated = false;
    hostnameResolved = false;
    netState = STATE_DISCOVERING_SERVER;
    networkStatusText = "Timeout (Retry)";
    idleNeedsFullRedraw = true;
    lastDiscoveryAttemptMs = 0;
  }
}

void sendDetectionTCP(const String& epc, const String& date, const String& time, const char* dir) {
  if (netState == STATE_CONNECTED && tcpClient && tcpClient.connected()) {
    String json = "{\"type\":\"detection\",\"epc\":\"" + epc +
                  "\",\"date\":\"" + date +
                  "\",\"time\":\"" + time +
                  "\",\"direction\":\"" + String(dir) +
                  "\",\"deviceId\":\"" + getPermanentDeviceId() + "\"}\n";
    tcpClient.print(json);
    tcpClient.flush();
    DBG("[TCP TX] Sent live detection: "); DBGLN(epc);
  } else {
    DBG("[TCP] Offline. Detection buffered in NVS (count=");
    DBG(nvsCount);
    DBGLN(")");
  }
}

// ─────────────────────────────────────────────────────────────
//  CENTRAL NETWORK SERVICE LOOP
// ─────────────────────────────────────────────────────────────
void serviceNetwork() {
  unsigned long now = millis();

  // 1. Service gate relay auto-shutoff
  serviceRelay();

  // 2. Service non-blocking UDP discovery & server beacons
  serviceIncomingUDPDiscovery();

  // 3. Service fallback WebServer
  server.handleClient();

  // 4. Wi-Fi Status Check & Auto Reconnect (every 1s)
  if (now - lastWifiCheckMs >= 1000) {
    lastWifiCheckMs = now;

    if (WiFi.status() != WL_CONNECTED) {
      if (netState != STATE_WIFI_DISCONNECTED) {
        DBGLN("[WiFi] Connection dropped!");
#if CLOUD_MODE == 2
        cloudFallback = false;
        lanProbeCount = 0;
#endif
        tcpClient.stop();
        isAuthenticated = false;
        hostnameResolved = false;
        netState = STATE_WIFI_DISCONNECTED;
        networkStatusText = "WiFi Lost";
        idleNeedsFullRedraw = true;
      }
      WiFi.reconnect();
      return;
    } else {
      if (netState == STATE_WIFI_DISCONNECTED) {
        lastKnownLocalIP = WiFi.localIP();
        ipString = lastKnownLocalIP.toString();
        DBG("[WiFi] Reconnected! Local IP: "); DBGLN(ipString);

        // Re-initialize mDNS and UDP
        MDNS.end();
        MDNS.begin("esp32-gate");
        udpDiscovery.begin(UDP_DISCOVERY_PORT);

        netState = STATE_DISCOVERING_SERVER;
        hostnameResolved = false;
        lastDiscoveryAttemptMs = 0;
        networkStatusText = "Discovering...";
        idleNeedsFullRedraw = true;
      }

      // Check if DHCP assigned a new IP address to ESP32
      if (WiFi.localIP() != lastKnownLocalIP) {
        lastKnownLocalIP = WiFi.localIP();
        ipString = lastKnownLocalIP.toString();
        DBG("[WiFi] DHCP assigned new IP to ESP32: "); DBGLN(ipString);
        idleNeedsFullRedraw = true;

        if (netState == STATE_CONNECTED && tcpClient.connected()) {
          String statusMsg = "{\"type\":\"status\",\"status\":\"online\",\"deviceId\":\"" +
                             getPermanentDeviceId() + "\",\"ip\":\"" + ipString + "\"}\n";
          tcpClient.print(statusMsg);
        }
      }
    }
  }

  // 5. State Machine Execution
  switch (netState) {
    case STATE_WIFI_DISCONNECTED:
      break;

    case STATE_DISCOVERING_SERVER:
      if (now - lastDiscoveryAttemptMs >= DISCOVERY_PROBE_INTERVAL_MS) {
        lastDiscoveryAttemptMs = now;
        sendDiscoveryProbeUDP();
        networkStatusText = "Searching Server";
        idleNeedsFullRedraw = true;
      }
      break;

    case STATE_CONNECTING_TCP:
      if (now - lastTcpAttemptMs >= TCP_RETRY_INTERVAL_MS) {
        lastTcpAttemptMs = now;
        attemptTCPConnect();
      }
      break;

    case STATE_AUTHENTICATING:
    case STATE_CONNECTED:
      serviceTCPClient();
      break;
  }
}

// ─────────────────────────────────────────────────────────────
//  FALLBACK HTTP HANDLERS
// ─────────────────────────────────────────────────────────────
void addCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
}

void handleRoot() {
  addCORSHeaders();
  String html =
    "<html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'>"
    "<title>Vehicle Gate Logger</title>"
    "<style>body{font-family:system-ui,sans-serif;padding:20px;background:#111;color:#eee}"
    "h2{color:#00e5ff}.card{background:#222;padding:15px;border-radius:8px;margin-bottom:15px}"
    "b{color:#fff}a{color:#00e5ff;text-decoration:none}</style></head><body>"
    "<h2>Vehicle Gate Logger (Dual RFID D2D)</h2>"
    "<div class='card'>"
    "<p>Device ID: <b>" + getPermanentDeviceId() + "</b></p>"
    "<p>MAC Address: <b>" + deviceMacAddress + "</b></p>"
    "<p>Local IP: <b>" + ipString + "</b></p>"
    "<p>Target Server: <b>" + (hostnameResolved ? serverIP.toString() + ":" + String(serverPort) : "Discovering...") + "</b></p>"
    "<p>Status: <b>" + networkStatusText + "</b></p>"
    "<p>Records buffered: <b>" + String(nvsCount) + " / " + String(MAX_RECORDS) + "</b></p>"
    "<p>Total detections: <b>" + String(totalDetect) + "</b></p>"
    "</div>"
    "<ul>"
    "<li><a href='/dump'>/dump</a> — JSON dump of records</li>"
    "<li><a href='/stats'>/stats</a> — JSON diagnostic statistics</li>"
    "<li><a href='/open'>/open</a> — Trigger gate barrier open</li>"
    "<li><a href='/clear'>/clear</a> — Clear all local records</li>"
    "</ul>"
    "</body></html>";
  server.send(200, "text/html", html);
}

void handleDump() {
  addCORSHeaders();
  String json = "{\"count\":" + String(nvsCount) + ",\"records\":[";
  bool first = true;
  for (uint32_t i = 0; i < nvsCount; i++) {
    String rec = nvsReadRecord(i);
    String rj  = recordToJSON(rec, i);
    if (rj.length() == 0) continue;
    if (!first) json += ",";
    json += rj;
    first = false;
  }
  json += "]}";
  server.send(200, "application/json", json);
}

void handleStats() {
  addCORSHeaders();
  String json = "{\"deviceId\":\"" + getPermanentDeviceId() + "\"" +
                ",\"mac\":\"" + deviceMacAddress + "\"" +
                ",\"ip\":\"" + ipString + "\"" +
                ",\"count\":" + String(nvsCount) +
                ",\"head\":"  + String(nvsHead) +
                ",\"tail\":"  + String(nvsTail) +
                ",\"total\":" + String(totalDetect) +
                ",\"serverIP\":\"" + serverIP.toString() + "\"" +
                ",\"serverPort\":" + String(serverPort) +
                ",\"netState\":" + String((int)netState) +
                ",\"authenticated\":" + String(isAuthenticated ? "true" : "false") + "}";
  server.send(200, "application/json", json);
}

void handleOpenGate() {
  addCORSHeaders();
  triggerGateRelay();
  server.send(200, "application/json", "{\"status\":\"ok\",\"action\":\"gate_opened\"}");
}

void handleClear() {
  addCORSHeaders();
  nvsClearAll();
  totalDetect = 0;
  idleNeedsFullRedraw = true;
  server.send(200, "application/json", "{\"status\":\"cleared\"}");
}

void handleNotFound() {
  addCORSHeaders();
  server.send(404, "application/json", "{\"error\":\"not found\"}");
}

void setupWiFiAndServer() {
  deviceMacAddress = WiFi.macAddress();
  getPermanentDeviceId();

  // 1. SoftAP setup (fallback)
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
  WiFi.softAP(AP_SSID, AP_PASS);

  // 2. Station setup (connect to SPJ Router)
  DBG("[WiFi] Connecting to SSID: "); DBGLN(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(400);
    DBG(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    lastKnownLocalIP = WiFi.localIP();
    ipString = lastKnownLocalIP.toString();
    DBG("\n[WiFi] Connected to SPJ Router! Local IP: "); DBGLN(ipString);

    // Start mDNS responder
    if (MDNS.begin("esp32-gate")) {
      DBG("[mDNS] Responder started. Host: esp32-gate.local\n");
    }
    udpDiscovery.begin(UDP_DISCOVERY_PORT);

    netState = STATE_DISCOVERING_SERVER;
    networkStatusText = "Discovering Server";
  } else {
    ipString = WiFi.softAPIP().toString();
    DBGLN("\n[WiFi] Router connection failed, running in SoftAP mode.");
    netState = STATE_WIFI_DISCONNECTED;
    networkStatusText = "WiFi Failed";
  }

  // 3. Web server
  server.on("/",       HTTP_GET, handleRoot);
  server.on("/dump",   HTTP_GET, handleDump);
  server.on("/stats",  HTTP_GET, handleStats);
  server.on("/open",   HTTP_GET, handleOpenGate);
  server.on("/clear",  HTTP_GET, handleClear);
  server.onNotFound(handleNotFound);
  server.begin();
  DBGLN("[HTTP] Local web server started on port 80");
}

// ─────────────────────────────────────────────────────────────
//  TFT DISPLAY SCREENS
// ─────────────────────────────────────────────────────────────
void showIdleScreen() {
  static bool staticDrawn = false;
  static int  lastSecond  = -1;

  if (idleNeedsFullRedraw) {
    staticDrawn         = false;
    lastSecond          = -1;
    idleNeedsFullRedraw = false;
  }

  DateTime now = rtc.now();

  if (!staticDrawn) {
    tft.fillScreen(ILI9341_BLACK);

    // Title
    tft.setFont(&FreeSansBold12pt7b);
    tft.setTextColor(ILI9341_CYAN);
    tft.setCursor(20, 32);
    tft.println("VEHICLE GATE LOGGER");

    // Subtitle
    tft.setFont(&FreeSans9pt7b);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(20, 52);
    tft.println("Local D2D RFID Access");

    // Static labels
    tft.setTextColor(ILI9341_DARKGREY);
    tft.setCursor(10, 75);  tft.print("Device:");
    tft.setCursor(10, 95);  tft.print("Time:");
    tft.setCursor(10, 115); tft.print("Date:");
    tft.setCursor(10, 135); tft.print("Total:");
    tft.setCursor(10, 155); tft.print("Buffer:");
    tft.setCursor(10, 175); tft.print("IP:");
    tft.setCursor(10, 195); tft.print("Server:");
    tft.setCursor(10, 215); tft.print("Status:");

    // Device ID value
    tft.setTextColor(ILI9341_LIGHTGREY);
    tft.setCursor(80, 75);
    tft.print(getPermanentDeviceId().substring(0, 18));

    staticDrawn = true;
    lastSecond  = -1;
  }

  if (now.second() != lastSecond) {
    lastSecond = now.second();

    tft.setFont(&FreeSans9pt7b);

    // Time value
    tft.fillRect(80, 82, 220, 16, ILI9341_BLACK);
    tft.setTextColor(ILI9341_YELLOW);
    tft.setCursor(80, 95);
    tft.print(getTimeString());

    // Date value
    tft.fillRect(80, 102, 220, 16, ILI9341_BLACK);
    tft.setTextColor(ILI9341_YELLOW);
    tft.setCursor(80, 115);
    tft.print(getDateString());

    // Total scans
    tft.fillRect(80, 122, 220, 16, ILI9341_BLACK);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(80, 135);
    tft.print(totalDetect);

    // NVS records
    tft.fillRect(80, 142, 220, 16, ILI9341_BLACK);
    tft.setTextColor(nvsCount > 0 ? ILI9341_ORANGE : ILI9341_GREEN);
    tft.setCursor(80, 155);
    tft.print(nvsCount);
    tft.print(" / ");
    tft.print(MAX_RECORDS);

    // Local IP
    tft.fillRect(80, 162, 220, 16, ILI9341_BLACK);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(80, 175);
    tft.print(ipString);

    // Server IP & Port
    tft.fillRect(80, 182, 220, 16, ILI9341_BLACK);
    tft.setTextColor(hostnameResolved ? ILI9341_GREEN : ILI9341_YELLOW);
    tft.setCursor(80, 195);
    if (hostnameResolved) {
      tft.print(serverIP.toString());
      tft.print(":");
      tft.print(serverPort);
    } else {
      tft.print("Discovering...");
    }

    // Status
    tft.fillRect(80, 202, 220, 16, ILI9341_BLACK);
    if (netState == STATE_CONNECTED) {
      tft.setTextColor(ILI9341_GREEN);
    } else if (netState == STATE_WIFI_DISCONNECTED) {
      tft.setTextColor(ILI9341_RED);
    } else {
      tft.setTextColor(ILI9341_YELLOW);
    }
    tft.setCursor(80, 215);
    tft.print(networkStatusText);
  }
}

void showTagScreen(const String& epc, const String& date, const String& time, const char* dir) {
  tagScreenActive = true;
  idleNeedsFullRedraw = true;

  tft.fillScreen(ILI9341_BLACK);

  // Direction Header
  tft.setFont(&FreeSansBold12pt7b);
  if (strcmp(dir, "IN") == 0) {
    tft.fillRect(0, 0, 320, 40, ILI9341_BLUE);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(70, 28);
    tft.print("VEHICLE ENTRY (IN)");
  } else {
    tft.fillRect(0, 0, 320, 40, ILI9341_NAVY);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(75, 28);
    tft.print("VEHICLE EXIT (OUT)");
  }

  tft.setFont(&FreeSans9pt7b);
  tft.setTextColor(ILI9341_WHITE);

  // EPC
  tft.setCursor(10, 70);
  tft.print("Tag EPC:");
  tft.setTextColor(ILI9341_YELLOW);
  tft.setCursor(10, 95);
  tft.print(epc.length() > 20 ? epc.substring(0, 20) + "..." : epc);

  // Time & Date
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(10, 130);
  tft.print("Time: ");
  tft.setTextColor(ILI9341_CYAN);
  tft.print(time);
  tft.print("  Date: ");
  tft.print(date);

  // Status line waiting for authorization feedback
  tft.setTextColor(ILI9341_YELLOW);
  tft.setCursor(10, 225);
  tft.print("Validating with Server...");
}

// ─────────────────────────────────────────────────────────────
//  HANDLE DETECTION
// ─────────────────────────────────────────────────────────────
void handleDetection(const String& epc, const char* direction) {
  String date = getDateString();
  String time = getTimeString();

  totalDetect++;
  nvsWriteRecord(epc, date, time, direction);

  DBG("[SCAN] ["); DBG(direction); DBG("] ");
  DBG(epc); DBG("  "); DBG(date); DBG("  "); DBGLN(time);

  // Send immediately to backend over TCP
  sendDetectionTCP(epc, date, time, direction);

  // Show tag screen
  showTagScreen(epc, date, time, direction);

  // 2.2-second hold: keep servicing network so auth feedback is rendered instantly
  unsigned long holdEnd = millis() + 2200;
  while (millis() < holdEnd) {
    serviceNetwork();
    yield();
  }

  tagScreenActive = false;
}

// ─────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(100);
  DBGLN("\n=============================================");
  DBGLN("   Dual RFID Gate Logger (Seamless D2D Mode) ");
  DBGLN("=============================================");

  // Relay initialization
  if (GATE_RELAY_PIN >= 0) {
    pinMode(GATE_RELAY_PIN, OUTPUT);
    digitalWrite(GATE_RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
    DBGLN("[RELAY] Gate Relay initialized on pin " + String(GATE_RELAY_PIN));
  }

  // TFT initialization
  tft.begin();
  tft.setRotation(1);
  tft.fillScreen(ILI9341_BLACK);
  tft.setFont(&FreeSansBold12pt7b);
  tft.setTextColor(ILI9341_CYAN);
  tft.setCursor(20, 110);
  tft.println("Starting Gate Logger...");

  // RTC initialization
  Wire.begin(21, 22);
  if (!rtc.begin()) {
    DBGLN("[RTC] ERROR: DS3231 not found!");
  } else {
    if (rtc.lostPower()) {
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
      DBGLN("[RTC] Battery lost. Adjusted to compile time.");
    } else {
      DBGLN("[RTC] Time retained from battery.");
    }
  }

  // UHF readers UART
  uhfIN.begin(115200, SERIAL_8N1, UHF_IN_RX, UHF_IN_TX);
  uhfOUT.begin(115200, SERIAL_8N1, UHF_OUT_RX, UHF_OUT_TX);
  delay(400);
  DBGLN("[UHF] Setting TX Power to 30 dBm...");
  setTxPower(uhfIN,  TX_POWER_DBM);
  setTxPower(uhfOUT, TX_POWER_DBM);

  // NVS metadata
  nvsLoadMeta();

  // Network (Wi-Fi + UDP Discovery + mDNS + Web Server)
  setupWiFiAndServer();

  showIdleScreen();
  DBGLN("[System] Ready. Permanent Device ID: " + getPermanentDeviceId());
  DBGLN("Commands: d=dump records, c=clear, s=stats, o=open gate, t=set RTC time");
}

// ─────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────
void loop() {
  // 1. Service networking (Wi-Fi, UDP Discovery, TCP client, WebServer, Relay)
  serviceNetwork();

  // 2. Handle serial commands
  if (Serial.available()) {
    char cmd = Serial.read();
    if (cmd == 'd' || cmd == 'D') {
      Serial.println("========== NVS RECORD DUMP ==========");
      Serial.print("Total records: "); Serial.println(nvsCount);
      for (uint32_t i = 0; i < nvsCount; i++) {
        Serial.printf("[%03lu] %s\n", (unsigned long)i, nvsReadRecord(i).c_str());
      }
      Serial.println("=====================================");
    } else if (cmd == 'c' || cmd == 'C') {
      nvsClearAll();
      totalDetect = 0;
      idleNeedsFullRedraw = true;
      Serial.println("[Serial] Local records cleared.");
    } else if (cmd == 's' || cmd == 'S') {
      Serial.printf("DeviceID=%s IP=%s Server=%s:%d NetState=%d Auth=%d Count=%lu Total=%d\n",
                    getPermanentDeviceId().c_str(), ipString.c_str(),
                    serverIP.toString().c_str(), serverPort, (int)netState, (int)isAuthenticated,
                    (unsigned long)nvsCount, totalDetect);
    } else if (cmd == 'o' || cmd == 'O') {
      triggerGateRelay();
      Serial.println("[Serial] Gate barrier relay triggered.");
    } else if (cmd == 't' || cmd == 'T') {
      handleRTCSet();
    }
  }

  // 3. Scan UHF IN reader
  String epcIN = runInventoryBurst(uhfIN);
  if (epcIN.length() > 0) {
    if (isNewTag(epcIN, seenTagsIN, seenTagCountIN)) {
      handleDetection(epcIN, "IN");
    }
  }

  // 4. Scan UHF OUT reader
  String epcOUT = runInventoryBurst(uhfOUT);
  if (epcOUT.length() > 0) {
    if (isNewTag(epcOUT, seenTagsOUT, seenTagCountOUT)) {
      handleDetection(epcOUT, "OUT");
    }
  }

  // 5. Update idle display clock & status
  if (!tagScreenActive) {
    showIdleScreen();
  }
}
