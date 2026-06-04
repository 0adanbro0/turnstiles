#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include "PubSubClient.h"  
#include "ArduinoJson/ArduinoJson.h"
#include <Ticker.h>

Ticker emergencyTicker;
Ticker addingCardTicker;

const char* ssid = ""; // name of your network!!!
const char* password = ""; // password of your network!!!
const char* mqtt_server = ""; // ipv4 of your pc!!!
const int mqtt_port = 1883; 

// RFID 1 (ENTRANCE)
#define SS1_PIN 5
#define RST1_PIN 21
MFRC522 rfid1(SS1_PIN, RST1_PIN);

// RFID 2 (EXIT)
#define SS2_PIN 4
#define RST2_PIN 22
MFRC522 rfid2(SS2_PIN, RST2_PIN);

#define buzzerPin 17

#define RED_LED 27
#define GREEN_LED 25
#define BLUE_LED_UNKNOWN 26

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

  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.println("Тело сообщения: " + message);

  // Выделяем память под JSON (размер с запасом)
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("Ошибка парсинга JSON: ");
    Serial.println(error.c_str());
    return;
  }

  String topicStr = String(topic);

  if (topicStr == "skud/control/response") {
    String status = doc["status"].as<String>();
    
    if (status == "1") { greenSuccess(); }
    else if (status == "404") { blueError(); }
    else if (status == "422") { blueErrorLimit(); }
    else if (status == "0") { redError(); }
    else if (status == "registered") {
      tone(buzzerPin, 2000, 200); delay(250); tone(buzzerPin, 2000, 200);
    }
  }
  
  if (topicStr == "skud/control/status") {
    isEmergency = doc["isEmergency"].as<bool>();
    isAddingCard = doc["isAddingCard"].as<bool>();
    Serial.printf("Обновлен статус: ЧС=%s, РежимДобавления=%s\n", isEmergency?"ДА":"НЕТ", isAddingCard?"ДА":"НЕТ");
  }
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Подключение к MQTT брокеру... ");
    
    if (mqttClient.connect("ESP32_Gate_CARD_Main")) {
      Serial.println("УСПЕШНО");
      
      mqttClient.subscribe("skud/control/response");
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

  pinMode(buzzerPin, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BLUE_LED_UNKNOWN, OUTPUT);

  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected");

  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);

  SPI.begin(18, 19, 23, 5); 
  rfid1.PCD_Init();
  rfid2.PCD_Init();
}

void greenSuccess() {
  digitalWrite(RED_LED, LOW);
  tone(buzzerPin, 1500);
  delay(1000);
  digitalWrite(RED_LED, HIGH);
  noTone(buzzerPin);
}

void redError() {
  Serial.println("Доступ запрещен");
  tone(buzzerPin, 100);
  delay(500);
  noTone(buzzerPin);
}

void blueError(){
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  tone(buzzerPin, 100);
  Serial.println("Неизвестная карта, доступ запрещен");
  delay(1000);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);
  noTone(buzzerPin);
}

void blueErrorLimit(){
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  tone(buzzerPin, 300); delay(500);
  digitalWrite(BLUE_LED_UNKNOWN, LOW); noTone(buzzerPin);
  delay(200);
  tone(buzzerPin, 1500); digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  delay(500); digitalWrite(BLUE_LED_UNKNOWN, LOW); noTone(buzzerPin);
}

void sendMqttRequest(String uid, String gate) {
  if (WiFi.status() != WL_CONNECTED || !mqttClient.connected()) {
    Serial.println("Нет связи! Запрос отменен.");
    return;
  }

  JsonDocument doc;
  doc["user_id"] = uid;
  doc["direction"] = (gate == "ENTRANCE") ? "in" : "out";

  doc["isAddingCardStatus"] = isAddingCard ? "1" : "0";

  String jsonPayload;
  serializeJson(doc, jsonPayload);

  mqttClient.publish("skud/check", jsonPayload.c_str());
  Serial.println("[MQTT] Запрос отправлен в skud/check: " + jsonPayload);
}

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

void toggleEmergencyLED() {
  blinkState = !blinkState;
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, blinkState ? LOW : HIGH);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);
  if (blinkState) tone(buzzerPin, 1500); else tone(buzzerPin, 500);
}

void toggleAddingCardLED() {
  blinkState = !blinkState;
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, HIGH);
  digitalWrite(BLUE_LED_UNKNOWN, blinkState ? HIGH : LOW);
  if (blinkState) tone(buzzerPin, 1200, 100); 
}

void loop() {

  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();
  
  if ((isEmergency != lastEmergencyState && !isEmergency) || 
      (isAddingCard != lastAddingCardState && !isAddingCard)) {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(BLUE_LED_UNKNOWN, LOW);
    noTone(buzzerPin);
  }
  lastEmergencyState = isEmergency;
  lastAddingCardState = isAddingCard;

  if (!isEmergency) {
    if (millis() - timerRFID >= 40) {
      timerRFID = millis();
      checkReader(rfid1, "ENTRANCE");
      checkReader(rfid2, "EXIT");
    }
  }

  if (isEmergency) {
    addingCardTicker.detach();
    if (!emergencyTicker.active()) {
      emergencyTicker.attach(0.5, toggleEmergencyLED);
    }
  }
  else if (isAddingCard) {
    emergencyTicker.detach();
    if (!addingCardTicker.active()) {
      addingCardTicker.attach(1, toggleAddingCardLED);
    }
  } else {
    emergencyTicker.detach();
    addingCardTicker.detach();
  }

  if (millis() - timerHeartbeat >= 5000) {
    timerHeartbeat = millis();
    sendHeartbeat();
  }
}
