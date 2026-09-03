#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include "PubSubClient.h"
#include "ArduinoJson/ArduinoJson.h"

const char* ssid = "s24";
const char* password = "45504550";
const char* mqtt_server = "10.226.84.220";
const int mqtt_port = 1883;

// RFID 1 (ENTRANCE)
#define SS1_PIN 5
#define RST1_PIN 21
MFRC522 rfid1(SS1_PIN, RST1_PIN);

// RFID 2 (EXIT)
#define SS2_PIN 4
#define RST2_PIN 22
MFRC522 rfid2(SS2_PIN, RST2_PIN);

unsigned long timerRFID = 0;
unsigned long timerHeartbeat = 0;

bool isEmergency = false;
bool isAddingCard = false;
bool lastAddingCardState = false;
bool lastEmergencyState = false;
bool blinkState = false;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("\n[MQTT] Получено сообщение в топик: ");
  Serial.println(topic);

  //from bytes to string
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.println("Тело сообщения: " + message);

  // json memory
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("Ошибка парсинга JSON: ");
    Serial.println(error.c_str());
    return;
  }

  String topicStr = String(topic);
  
  if (topicStr == "skud/control/status") {
    isEmergency = doc["isEmergency"].as<bool>();
    isAddingCard = doc["isAddingCard"].as<bool>();
    Serial.printf("Обновлен статус: ЧС=%s, РежимДобавления=%s\n", isEmergency?"ДА":"НЕТ", isAddingCard?"ДА":"НЕТ");
  }
}

// function connection to MQTT-broker
void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Подключение к MQTT брокеру... ");

    if (mqttClient.connect("ESP32_Gate_CARD_Main")) {
      Serial.println("УСПЕШНО");

      mqttClient.subscribe("skud/control/status");
    } else {
      Serial.print("ошибка, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" пробуем снова через 3 секунды");
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);

  // wi-fi connection
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected");

  Serial.print("----------------" + WiFi.macAddress());

  // MQTT settings
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);

  // RFID running
  SPI.begin(18, 19, 23, 5); 
  rfid1.PCD_Init();
  rfid2.PCD_Init();
}

// MQTT sending
void sendMqttRequest(String uid, String gate) {
  if (WiFi.status() != WL_CONNECTED || !mqttClient.connected()) {
    Serial.println("Нет связи! Запрос отменен.");
    return;
  }

  JsonDocument doc;
  doc["user_id"] = uid;
  doc["direction"] = (gate == "ENTRANCE") ? "in" : "out";
  doc["isAddingCardStatus"] = isAddingCard ? "1" : "0";
  doc["nameEspReader"] = WiFi.macAddress();

  String jsonPayload;
  serializeJson(doc, jsonPayload);

  mqttClient.publish("skud/check", jsonPayload.c_str());
  Serial.println("[MQTT] Запрос отправлен в skud/check: " + jsonPayload);
}

// heartbeat
void sendHeartbeat() {
  if (mqttClient.connected()) {
    JsonDocument doc;
    doc["device_name"] = "ESP32_Gate_CARD_Main";
    doc["connection"] = "true";

    String jsonPayload;
    serializeJson(doc, jsonPayload);
    mqttClient.publish("skud/heartbeat", jsonPayload.c_str());
    Serial.println("[MQTT] Хартбит отправлен.");
  }
}

void checkReader(MFRC522 &reader, String gate) {
  if (!reader.PICC_IsNewCardPresent() || !reader.PICC_ReadCardSerial()) return;

  String uid = "";
  for (byte i = 0; i < reader.uid.size; i++) {
    uid += (reader.uid.uidByte[i] < 0x10 ? "0" : "");
    uid += String(reader.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  Serial.println("\nSCAN: " + uid + " (" + gate + ")");

  sendMqttRequest(uid, gate);

  reader.PICC_HaltA();
}

void loop() {
  // connection with MQTT
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  lastEmergencyState = isEmergency;
  lastAddingCardState = isAddingCard;

  if (!isEmergency) {
    if (millis() - timerRFID >= 40) {
      timerRFID = millis();
      checkReader(rfid1, "ENTRANCE");
      checkReader(rfid2, "EXIT");
    }
  }

  // heartbeat sending
  if (millis() - timerHeartbeat >= 5000) {
    timerHeartbeat = millis();
    sendHeartbeat();
  }
}