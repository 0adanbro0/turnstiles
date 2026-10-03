#include <WiFi.h>
#include "PubSubClient.h"
#include "ArduinoJson/ArduinoJson.h" 
#include <Ticker.h>

Ticker emergencyTicker;
Ticker addingCardTicker;

const char* ssid = "s24";
const char* password = "45504550";
const char* mqtt_server = "10.129.105.220"; 
const int mqtt_port = 1883;              

// Логин/пароль устройства на брокере. Пока брокер открытый, оставьте пустыми.
const char* mqtt_user = "";
const char* mqtt_pass = "";

// Роль в системе: "lock" (получает решения от считывателя) или "reader"
const char* DEVICE_ROLE = "lock";

#define buzzerPin 10

#define GREEN_LED 2 
#define RED_LED 4
#define BLUE_LED_UNKNOWN 3
#define RGB_ESP32C3_MODULE 8

unsigned long timerHeartbeat = 0;
unsigned long timerMqttReconnect = 0;
unsigned long timerBuzzerAction = 0;
unsigned long timerLedAction = 0;

bool isEmergency = false;
bool isAddingCard = false;
bool lastAddingCardState = false;
bool lastEmergencyState = false;

volatile bool triggerRegisteredTone = false;
bool blinkState = false;

// Мигание в особых режимах считается от АБСОЛЮТНОГО времени (синхронизированного с сервером),
// а не от момента включения режима: все платы переключаются в одну и ту же миллисекунду,
// независимо от того, когда каждая из них узнала о смене режима.
int currentMode = 0;              // 0 - обычный, 1 - ЧС, 2 - добавление карт
uint64_t lastPhase = 0;
bool phaseInit = false;

enum ActionState { IDLE, GREEN_OK, RED_ERR, BLUE_ERR, BLUE_LIMIT };
ActionState currentAction = IDLE;

// Идентификатор устройства = MAC. Он же device_name в heartbeat и часть персональных топиков.
String deviceId;
String topicResponse;
String topicStatus;
String topicTime;

// --- Синхронизация абсолютного времени с сервером (для синхронного мигания) ---
bool timeSynced = false;
uint64_t serverTimeAtSync = 0;   // server_time (мс от эпохи) в момент последней синхронизации
unsigned long millisAtSync = 0;  // millis() в тот же момент

// Текущее время в мс от эпохи. Пока синхронизации не было, используем millis() как есть:
// мигание работает, но не выровнено по абсолютному времени с другими платами.
uint64_t nowMs() {
  if (!timeSynced) return millis();
  return serverTimeAtSync + (uint64_t)(millis() - millisAtSync);
}

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// async managing diods
void handleEffects() {
  static bool step = false;
  
  if (currentAction == IDLE) return;

  if (currentAction == GREEN_OK) {
    if (timerLedAction == 0) {
      timerLedAction = millis();
      rgbLedWrite(RGB_ESP32C3_MODULE, 0, 50, 0); 
      digitalWrite(RED_LED, LOW);
      digitalWrite(GREEN_LED, HIGH);
      tone(buzzerPin, 1500);
    }
    if (millis() - timerLedAction >= 1000) {
      rgbLedWrite(RGB_ESP32C3_MODULE, 50, 0, 0); 
      digitalWrite(RED_LED, HIGH);
      digitalWrite(GREEN_LED, LOW);
      noTone(buzzerPin);
      timerLedAction = 0;
      currentAction = IDLE;
    }
  }
  
  if (currentAction == RED_ERR) {
    if (timerLedAction == 0) {
      timerLedAction = millis();
      tone(buzzerPin, 100);
    }
    if (millis() - timerLedAction >= 500) {
      noTone(buzzerPin);
      timerLedAction = 0;
      currentAction = IDLE;
    }
  }

  if (currentAction == BLUE_ERR) {
    if (timerLedAction == 0) {
      timerLedAction = millis();
      rgbLedWrite(RGB_ESP32C3_MODULE, 0, 0, 50); 
      digitalWrite(BLUE_LED_UNKNOWN, HIGH);
      tone(buzzerPin, 100);
    }
    if (millis() - timerLedAction >= 1000) {
      rgbLedWrite(RGB_ESP32C3_MODULE, 0, 0, 0); 
      digitalWrite(BLUE_LED_UNKNOWN, LOW);
      noTone(buzzerPin);
      timerLedAction = 0;
      currentAction = IDLE;
    }
  }

  if (currentAction == BLUE_LIMIT) {
    if (timerLedAction == 0) {
      timerLedAction = millis();
      step = false;
    }
    
    unsigned long diff = millis() - timerLedAction;
    if (diff == 0) {
      timerLedAction = millis();
      rgbLedWrite(RGB_ESP32C3_MODULE, 0, 0, 50); 
      digitalWrite(BLUE_LED_UNKNOWN, HIGH);
      tone(buzzerPin, 1500);
    }
    if (diff >= 1000) {
      rgbLedWrite(RGB_ESP32C3_MODULE, 0, 0, 0); 
      digitalWrite(BLUE_LED_UNKNOWN, LOW);
      noTone(buzzerPin);
      timerLedAction = 0;
      currentAction = IDLE;
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) { message += (char)payload[i]; }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) return;

  String topicStr = String(topic);
  Serial.println(doc["nameEspReader"].as<String>() + " - mac");

  // Результат сканирования. Сервер сам решает, каким устройствам его отправить (targets
  // считывателя), поэтому фильтр по MAC считывателя больше не нужен.
  // Если это устройство управляет замком, открывать можно ТОЛЬКО при status == "1".
  if (topicStr == topicResponse) {
    String status = doc["status"].as<String>();
    
    if (status == "1") { currentAction = GREEN_OK; }
    else if (status == "404") { currentAction = BLUE_ERR; }
    else if (status == "422") { currentAction = BLUE_LIMIT; }
    else if (status == "0") { currentAction = RED_ERR; }
    else if (status == "registered") {
      tone(buzzerPin, 2000, 200); 
    }
  }
  
  // Статус системы (ЧС, режим карт) приходит в персональный топик.
  // Неодобренному или заблокированному устройству сервер присылает false/false.
  if (topicStr == topicStatus) {
    isEmergency = doc["isEmergency"].as<bool>();
    isAddingCard = doc["isAddingCard"].as<bool>();
  }

  // Текущее время сервера приходит при каждом heartbeat (~раз в 5 с).
  // Пересчитываем смещение каждый раз, чтобы не накапливался дрейф millis().
  if (topicStr == topicTime) {
    serverTimeAtSync = doc["server_time"].as<uint64_t>();
    millisAtSync = millis();
    timeSynced = true;
  }
}

// MQTT connection
void tryReconnectMQTT() {
  // if it is connected
  if (mqttClient.connected()) {
    return; 
  }
  if (millis() - timerMqttReconnect >= 4000) {
    timerMqttReconnect = millis();
    Serial.print("[MQTT] Попытка подключения... ");

    const char* user = strlen(mqtt_user) > 0 ? mqtt_user : nullptr;
    const char* pass = strlen(mqtt_user) > 0 ? mqtt_pass : nullptr;

    if (mqttClient.connect(deviceId.c_str(), user, pass)) {
      Serial.println("УСПЕШНО");
      mqttClient.subscribe(topicResponse.c_str());
      mqttClient.subscribe(topicStatus.c_str());
      mqttClient.subscribe(topicTime.c_str());
    } else {
      Serial.printf("ошибка, rc=%d\n", mqttClient.state());
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(buzzerPin, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BLUE_LED_UNKNOWN, OUTPUT);

  rgbLedWrite(RGB_ESP32C3_MODULE, 50, 0, 0); 
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected");

  deviceId = WiFi.macAddress();
  topicResponse = "skud/dev/" + deviceId + "/response";
  topicStatus = "skud/dev/" + deviceId + "/status";
  topicTime = "skud/dev/" + deviceId + "/time";

  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512); 

  Serial.print("MAC: ");
  Serial.println(deviceId);
}

void sendHeartbeat() {
  if (!mqttClient.connected()) return;
  JsonDocument doc;
  doc["device_name"] = deviceId;
  doc["role"] = DEVICE_ROLE;
  doc["connection"] = "true";

  String jsonPayload;
  serializeJson(doc, jsonPayload);
  mqttClient.publish("skud/heartbeat", jsonPayload.c_str());
}

void loop() {
  if (!mqttClient.connected()) {
    tryReconnectMQTT();
  } else {
    mqttClient.loop();
  }

  handleEffects();

  //exit from special modes
  if ((isEmergency != lastEmergencyState && !isEmergency) || 
      (isAddingCard != lastAddingCardState && !isAddingCard)) {
    rgbLedWrite(RGB_ESP32C3_MODULE, 50, 0, 0); 
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, LOW);
    digitalWrite(BLUE_LED_UNKNOWN, LOW);
    noTone(buzzerPin);
  }
  lastEmergencyState = isEmergency;
  lastAddingCardState = isAddingCard;

  // Режим мигания: ЧС имеет приоритет над добавлением карт
  int mode = isEmergency ? 1 : (isAddingCard ? 2 : 0);
  if (mode != currentMode) {
    currentMode = mode;
    phaseInit = false; // при входе в режим не действуем на старой фазе, дождёмся первой новой
    blinkState = false;
  }

  if (currentMode != 0) {
    uint64_t period = (currentMode == 1) ? 500 : 1000;   // ЧС: 0.5 с, добавление карт: 1 с
    // Деление от абсолютного времени: граница фазы одна и та же на всех синхронизированных
    // платах, вне зависимости от того, когда каждая из них вошла в режим.
    uint64_t phase = nowMs() / period;

    // Действие только при смене фазы. Если loop() задержался, состояние всё равно
    // вычисляется из времени и остаётся в такт с остальными модулями.
    if (!phaseInit || phase != lastPhase) {
      phaseInit = true;
      lastPhase = phase;
      blinkState = (phase % 2) == 1;

      if (currentMode == 1) {
        // emergency
        rgbLedWrite(RGB_ESP32C3_MODULE, blinkState ? 0 : 50, blinkState ? 50 : 0, 0); 
        digitalWrite(GREEN_LED, blinkState ? HIGH : LOW);
        digitalWrite(RED_LED, blinkState ? LOW : HIGH);
        digitalWrite(BLUE_LED_UNKNOWN, LOW);
        tone(buzzerPin, blinkState ? 1500 : 500, 150);
      } else {
        // adding card function
        digitalWrite(GREEN_LED, LOW);
        digitalWrite(RED_LED, HIGH);
        rgbLedWrite(RGB_ESP32C3_MODULE, 0, 0, blinkState ? 50 : 0); 
        digitalWrite(BLUE_LED_UNKNOWN, blinkState ? HIGH : LOW);
        if (blinkState) tone(buzzerPin, 1200, 100); 
      }
    }
  }

  if (triggerRegisteredTone) {
    triggerRegisteredTone = false;
    tone(buzzerPin, 2000, 200);
  }

  // heartbeat
  if (millis() - timerHeartbeat >= 5000) {
    timerHeartbeat = millis();
    Serial.print("heartBeat, im alive!");
    sendHeartbeat();
  }
}
