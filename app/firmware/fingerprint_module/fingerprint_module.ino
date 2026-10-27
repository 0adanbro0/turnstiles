// Боевая прошивка считывателя отпечатков. Полностью беспроводная, включая регистрацию новых
// людей: никакого провода, никакого ключа администратора на плате вообще. Команду "начни
// регистрацию" шлёт сервер по MQTT (её запускает кнопка в панели администратора), устройство
// выполняет захват отпечатка на обоих сенсорах и отчитывается результатом - сервер сам создаёт
// привязку в базе. Устройству для этого ключ не нужен: оно никогда не обращается к HTTP API,
// только публикует/читает MQTT, как и остальные устройства в системе.
//
// Файлы fingerprint_enroll.ino и прошлая версия этого файла с Serial-командой "enroll" больше
// не нужны - эта версия полностью их заменяет.

#include <WiFi.h>
#include "PubSubClient.h"
#include "ArduinoJson/ArduinoJson.h"
#include <Adafruit_Fingerprint.h>

// ========== КОНФИГ ==========
const char* WIFI_SSID = "s24";
const char* WIFI_PASSWORD = "45504550";
const char* mqtt_server = "10.73.232.220";
const int mqtt_port = 1883;
const char* mqtt_user = "";
const char* mqtt_pass = "";
const char* DEVICE_ROLE = "reader";
const char* READER_1_NAME = "ENTRANCE_FINGER";
const char* READER_2_NAME = "EXIT_FINGER";

// ========== PINS сенсоров ==========
HardwareSerial fingerSerial1(1);
HardwareSerial fingerSerial2(2);
#define FINGER1_RX 16
#define FINGER1_TX 17
#define FINGER2_RX 25
#define FINGER2_TX 26

Adafruit_Fingerprint finger1(&fingerSerial1);
Adafruit_Fingerprint finger2(&fingerSerial2);

String deviceId;
String topicStatus;
String topicEnrollCmd;
String topicEnrollResult;
String topicEnrollProgress;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long timerHeartbeat = 0;
unsigned long timerReconnect = 0;
unsigned long heartbeatSentAt = 0;

bool isEmergency = false;
bool isAddingCard = false;

struct ReaderState {
  int lastId = -1;
  bool fingerPresent = false;
};
ReaderState reader1State;
ReaderState reader2State;

// Команда регистрации приходит в mqttCallback - там НЕЛЬЗЯ делать долгую блокирующую работу
// (ждать, пока человек приложит палец, может занять десятки секунд), иначе ломается
// обслуживание MQTT-сокета. Поэтому callback только взводит флаг, а сама работа выполняется
// в основном loop().
volatile bool enrollRequested = false;
int enrollFingerprintId = 0;

bool enrollResultPending = false;
bool enrollResultOk = false;
String enrollResultError;

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  delay(1500);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("\n[WiFi] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] Connected: " + WiFi.localIP().toString());
  WiFi.setSleep(false);

  deviceId = WiFi.macAddress();
  topicStatus = "skud/dev/" + deviceId + "/status";
  topicEnrollCmd = "skud/dev/" + deviceId + "/enroll";
  topicEnrollResult = "skud/dev/" + deviceId + "/enroll-result";
  topicEnrollProgress = "skud/dev/" + deviceId + "/enroll-progress";
  Serial.println("[SYS] Device ID: " + deviceId);

  fingerSerial1.begin(57600, SERIAL_8N1, FINGER1_RX, FINGER1_TX);
  fingerSerial2.begin(57600, SERIAL_8N1, FINGER2_RX, FINGER2_TX);

  bool ok1 = finger1.verifyPassword();
  bool ok2 = finger2.verifyPassword();
  Serial.println(ok1 ? "[FP1] Датчик найден" : "[FP1] НЕ отвечает - проверь проводку");
  Serial.println(ok2 ? "[FP2] Датчик найден" : "[FP2] НЕ отвечает - проверь проводку");
  if (!ok1 || !ok2) {
    Serial.println("Датчики не отвечают. Останов.");
    while (true) delay(1000);
  }

  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);

  Serial.println("[SYS] Ready. Waiting for fingers...");
}

// ========== MQTT ==========
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;

  String topicStr = String(topic);

  if (topicStr == topicStatus) {
    isEmergency = doc["isEmergency"] | false;
    isAddingCard = doc["isAddingCard"] | false;
    return;
  }

  if (topicStr == topicEnrollCmd) {
    // Только взводим флаг - никакой долгой работы прямо тут (см. комментарий у объявления флага)
    enrollFingerprintId = doc["fingerprintId"] | 0;
    enrollRequested = (enrollFingerprintId > 0);
    return;
  }
}

void checkMqttConnection() {
  if (mqttClient.connected()) return;
  if (millis() - timerReconnect < 5000) return;
  timerReconnect = millis();

  const char* user = strlen(mqtt_user) > 0 ? mqtt_user : nullptr;
  const char* pass = strlen(mqtt_user) > 0 ? mqtt_pass : nullptr;

  if (mqttClient.connect(deviceId.c_str(), user, pass)) {
    mqttClient.subscribe(topicStatus.c_str());
    mqttClient.subscribe(topicEnrollCmd.c_str());
    sendHeartbeat();
  }
}

void sendProgress(const String &msg) {
  if (!mqttClient.connected()) return;
  JsonDocument doc;
  doc["message"] = msg;
  String p;
  serializeJson(doc, p);
  mqttClient.publish(topicEnrollProgress.c_str(), p.c_str());
}

void sendMqttRequest(int fingerId, const char* gateLabel, const char* direction) {
  if (!mqttClient.connected()) return;
  JsonDocument doc;
  doc["user_id"] = String(fingerId);
  doc["direction"] = direction;
  doc["credential_type"] = "fingerprint";
  doc["nameEspReader"] = deviceId;
  String payloadStr;
  serializeJson(doc, payloadStr);
  mqttClient.publish("skud/check", payloadStr.c_str());
  Serial.printf("[MQTT] %s -> fingerID %d (%s)\n", gateLabel, fingerId, direction);
}

void sendHeartbeat() {
  if (!mqttClient.connected()) return;
  JsonDocument doc;
  doc["device_name"] = deviceId;
  doc["role"] = DEVICE_ROLE;
  doc["connection"] = "true";
  String payloadStr;
  serializeJson(doc, payloadStr);
  heartbeatSentAt = millis();
  mqttClient.publish("skud/heartbeat", payloadStr.c_str());
}

// ========== СКАНИРОВАНИЕ (обычная работа) ==========
void processFinger(Adafruit_Fingerprint &sensor, ReaderState &state, const char* gateName, const char* direction) {
  uint8_t p = sensor.getImage();
  if (p == FINGERPRINT_NOFINGER) {
    if (state.fingerPresent) { state.fingerPresent = false; state.lastId = -1; }
    return;
  }
  if (p != FINGERPRINT_OK) return;
  if (sensor.image2Tz() != FINGERPRINT_OK) return;
  if (sensor.fingerFastSearch() != FINGERPRINT_OK) return;
  if (sensor.fingerID == state.lastId && state.fingerPresent) return;

  state.lastId = sensor.fingerID;
  state.fingerPresent = true;
  sendMqttRequest(sensor.fingerID, gateName, direction);
}


// ========== РЕГИСТРАЦИЯ (по команде с сервера) ==========
// Два скана подряд одного и того же пальца на ОДНОМ сенсоре, затем сохранение под id.
bool enrollOnSensor(Adafruit_Fingerprint &sensor, int id, const char* label, const char* human, String &err) {
  sendProgress(String("Приложите палец к ") + human + " (1-й скан)");
  unsigned long start = millis();
  while (sensor.getImage() != FINGERPRINT_OK) {
    mqttClient.loop();
    if (millis() - start > 20000) { err = String(label) + ": истекло время ожидания пальца"; return false; }
    delay(50);
  }
  if (sensor.image2Tz(1) != FINGERPRINT_OK) {
    err = String(label) + ": не удалось обработать первый скан";
    return false;
  }

  sendProgress("Уберите палец");
  delay(1500);
  while (sensor.getImage() != FINGERPRINT_NOFINGER) { mqttClient.loop(); delay(50); }

  sendProgress(String("Приложите тот же палец ещё раз к ") + human + " (2-й скан)");
  start = millis();
  while (sensor.getImage() != FINGERPRINT_OK) {
    mqttClient.loop();
    if (millis() - start > 20000) { err = String(label) + ": истекло время ожидания второго скана"; return false; }
    delay(50);
  }
  if (sensor.image2Tz(2) != FINGERPRINT_OK) {
    err = String(label) + ": не удалось обработать второй скан";
    return false;
  }
  if (sensor.createModel() != FINGERPRINT_OK) {
    err = String(label) + ": два скана не совпали между собой";
    return false;
  }
  uint8_t result = sensor.storeModel(id);
  if (result == FINGERPRINT_OK) return true;
  err = String(label) + ": ошибка записи в память сенсора (код " + String(result) + ")";
  return false;
}

// Выполняется в основном loop() по флагу enrollRequested - не из mqttCallback (см. выше)
void runEnrollment() {
  Serial.printf("\n=== Регистрация ID %d (команда с сервера) ===\n", enrollFingerprintId);

  String err;
  bool ok1 = enrollOnSensor(finger1, enrollFingerprintId, "FP1 / entrance", "считывателю входа", err);
  if (ok1) sendProgress("Первый считыватель готов. Теперь второй сенсор.");
  bool ok2 = ok1 ? enrollOnSensor(finger2, enrollFingerprintId, "FP2 / exit", "считывателю выхода", err) : false;

  enrollResultOk = ok1 && ok2;
  enrollResultError = enrollResultOk ? "" : err;
  enrollResultPending = true;

  Serial.println(enrollResultOk ? "Готово, отправляем результат на сервер." : ("Ошибка: " + enrollResultError));
}

void loop() {
  checkMqttConnection();
  mqttClient.loop();

  if (enrollRequested) {
    enrollRequested = false;
    runEnrollment();
  }

  if (enrollResultPending) {
    if (mqttClient.connected()) {
      JsonDocument doc;
      doc["ok"] = enrollResultOk;
      if (!enrollResultOk) doc["error"] = enrollResultError;
      String payloadStr;
      serializeJson(doc, payloadStr);
      mqttClient.publish(topicEnrollResult.c_str(), payloadStr.c_str(), true); // qos через publish с retain=false де-факто; MQTT.js-брокер qos0 по умолчанию для этого клиента
      enrollResultPending = false;
    }
    // если не подключены - оставляем enrollResultPending=true, попробуем отправить на следующем тике
    // после того как checkMqttConnection() восстановит связь
  }

  if (millis() - timerHeartbeat >= 10000) {
    timerHeartbeat = millis();
    sendHeartbeat();
  }

  if (!isEmergency) {
    processFinger(finger1, reader1State, READER_1_NAME, "in");
    processFinger(finger2, reader2State, READER_2_NAME, "out");
  }

  delay(10);
}
