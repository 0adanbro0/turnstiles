#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include "PubSubClient.h"
#include "ArduinoJson/ArduinoJson.h"

// ========== КОНФИГ ==========
const char* ssid = "s24";           // <-- ВПИШИ СВОИ
const char* password = "45504550";       // <-- ВПИШИ СВОИ
const char* mqtt_server = "";      // <-- IP БЭКЕНДА (НЕ "s24", если нет DNS)
const int mqtt_port = 1883;

// Логин/пароль устройства на брокере. Пока брокер открытый, оставьте пустыми.
const char* mqtt_user = "";
const char* mqtt_pass = "";

// Роль в системе. Идентификатор устройства = MAC (заполняется в setup).
const char* DEVICE_ROLE = "reader";
String deviceId;
String topicStatus;

// Имена считывателей (только для логов в Serial)
const char* READER_1_NAME = "ENTRANCE_READER"; // Вход
const char* READER_2_NAME = "EXIT_READER";     // Выход

// ========== PINS ==========
// RFID 1 (ENTRANCE)
#define SS1_PIN 5
#define RST1_PIN 21
MFRC522 rfid1(SS1_PIN, RST1_PIN);

// RFID 2 (EXIT)
#define SS2_PIN 4
#define RST2_PIN 22
MFRC522 rfid2(SS2_PIN, RST2_PIN);

// ========== STATE ==========
WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long timerRFID = 0;
unsigned long timerHeartbeat = 0;
unsigned long timerReconnect = 0;

bool isEmergency = false;
bool isAddingCard = false;

// --- Дебаунс для КАЖДОГО ридера отдельно ---
struct ReaderState {
  String lastUid = "";
  unsigned long lastSeen = 0;
  bool cardPresent = false;
};
ReaderState reader1State;
ReaderState reader2State;

const unsigned long DEBOUNCE_MS = 2000; // 2 сек игнорируем повтор одного UID

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  delay(100);

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("\n[WiFi] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] Connected: " + WiFi.localIP().toString());

  // Идентификатор = MAC, персональный топик статуса
  deviceId = WiFi.macAddress();
  topicStatus = "skud/dev/" + deviceId + "/status";
  Serial.println("[SYS] Device ID: " + deviceId);

  // MQTT
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024); // На всякий случай для больших JSON

  // SPI & RFID
  // SPI.begin(SCK, MISO, MOSI, SS) - дефолтные VSPI пины ESP32: 18, 19, 23, 5
  // Ты передаешь SS1_PIN (5) как последний аргумент -> OK для первого ридера.
  // Второй ридер использует SS2_PIN (4). MFRC522 либа сама тянет SS LOW/HIGH в PCD_Init/Transceive.
  SPI.begin(18, 19, 23, 5); 
  rfid1.PCD_Init();
  rfid2.PCD_Init();
  
  Serial.println("[SYS] Ready. Waiting for cards...");
}

// ========== MQTT CALLBACK ==========
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc; // Исправлено: убрали размер <512> и изменили тип
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) return;

  // Сервер шлёт статус в персональный топик. Неодобренному устройству приходит false/false.
  if (String(topic) == topicStatus) {
    isEmergency = doc["isEmergency"] | false;
    isAddingCard = doc["isAddingCard"] | false;
    Serial.printf("[MQTT] Status: Emergency=%s, AddCard=%s\n", isEmergency?"ON":"OFF", isAddingCard?"ON":"OFF");
  }
  // TODO: результат скана приходит в skud/dev/<MAC>/response (нужно подписаться), если нужна индикация на этом модуле
}

// ========== MQTT RECONNECT (НЕБЛОКИРУЮЩИЙ) ==========
void checkMqttConnection() {
  if (mqttClient.connected()) return;

  if (millis() - timerReconnect < 5000) return; // Пробуем раз в 5 сек
  timerReconnect = millis();

  Serial.print("[MQTT] Reconnecting... ");
  const char* user = strlen(mqtt_user) > 0 ? mqtt_user : nullptr;
  const char* pass = strlen(mqtt_user) > 0 ? mqtt_pass : nullptr;

  if (mqttClient.connect(deviceId.c_str(), user, pass)) {
    Serial.println("OK");
    mqttClient.subscribe(topicStatus.c_str());
    // Сразу шлем хартбит и текущий статус при коннекте
    sendHeartbeat();
  } else {
    Serial.print("Failed, rc=");
    Serial.println(mqttClient.state());
  }
}

// ========== HELPERS ==========
String getUidString(MFRC522 &reader) {
  String uid = "";
  for (byte i = 0; i < reader.uid.size; i++) {
    if (reader.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(reader.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// gateLabel нужен только для лога. Серверу уходит deviceId, а вход/выход различаются по direction.
void sendMqttRequest(String uid, const char* gateLabel, const char* direction) {
  if (!mqttClient.connected()) return;

  JsonDocument doc; // Исправлено: убрали размер <256> и изменили тип
  doc["user_id"] = uid;
  doc["direction"] = direction;
  doc["isAddingCardStatus"] = isAddingCard ? "1" : "0"; // сервер это поле игнорирует, режим определяется на сервере
  doc["nameEspReader"] = deviceId; // Идентификатор устройства, как в heartbeat

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish("skud/check", payload.c_str());
  Serial.printf("[MQTT] %s -> %s (%s)\n", gateLabel, uid.c_str(), direction);
}


void sendHeartbeat() {
  if (!mqttClient.connected()) return;
  JsonDocument doc; // Исправлено: убрали размер <192> и изменили тип
  doc["device_name"] = deviceId;
  doc["role"] = DEVICE_ROLE;
  doc["connection"] = "true";
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  
  String payload;
  serializeJson(doc, payload);
  // Без retain: иначе брокер отдаст устаревший heartbeat бекенду при его перезапуске
  mqttClient.publish("skud/heartbeat", payload.c_str());
}


// Проверка ридера с дебаунсом
void processReader(MFRC522 &reader, ReaderState &state, const char* gateName, const char* direction) {
  // 1. Есть карта в зоне?
  bool present = reader.PICC_IsNewCardPresent() && reader.PICC_ReadCardSerial();

  if (present) {
    String uid = getUidString(reader);

    // 2. Дебаунс: если Тот ЖЕ UID и прошло < DEBOUNCE_MS -> игнорируем
    if (uid == state.lastUid && (millis() - state.lastSeen < DEBOUNCE_MS)) {
      reader.PICC_HaltA(); // Важно: усыпляем карту, иначе будет читаться бесконечно
      return;
    }

    // 3. Новый UID или прошло много времени -> Обрабатываем
    state.lastUid = uid;
    state.lastSeen = millis();
    state.cardPresent = true;

    sendMqttRequest(uid, gateName, direction);
    reader.PICC_HaltA(); // Усыпляем после успешного чтения
  } 
  else {
    // Карта убрали
    if (state.cardPresent) {
      state.cardPresent = false;
      state.lastUid = ""; // Сбрасываем UID, чтобы при следующем приложении сработало мгновенно
    }
  }
}

// ========== MAIN LOOP ==========
void loop() {
  // 1. MQTT Connection & Loop (обязательно каждый цикл)
  checkMqttConnection();
  mqttClient.loop();

  // 2. Heartbeat
  if (millis() - timerHeartbeat >= 10000) { // 10 сек достаточно
    timerHeartbeat = millis();
    sendHeartbeat();
  }

  // 3. RFID Polling (только если НЕ ЧС)
  // Опрос ридеров лучше делать максимально часто, но логика внутри processReader отсеет дубли
  if (!isEmergency) {
    processReader(rfid1, reader1State, READER_1_NAME, "in");
    processReader(rfid2, reader2State, READER_2_NAME, "out");
  }
  
  // Маленькая задержка, чтобы не забивать CPU (FreeRTOS на ESP32 любит yield)
  delay(10); 
}
