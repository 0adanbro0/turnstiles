#include <WiFi.h>
#include "PubSubClient.h"
#include "ArduinoJson/ArduinoJson.h" 
#include <Ticker.h>

Ticker emergencyTicker;
Ticker addingCardTicker;

const char* ssid = "s24";
const char* password = "45504550";
const char* mqtt_server = "10.161.2.220"; 
const int mqtt_port = 1883;              

#define buzzerPin 10

#define GREEN_LED 2 
#define RED_LED 4
#define BLUE_LED_UNKNOWN 3

unsigned long timerHeartbeat = 0;
unsigned long timerMqttReconnect = 0;
unsigned long timerBuzzerAction = 0;
unsigned long timerLedAction = 0;

bool isEmergency = false;
bool isAddingCard = false;
bool lastAddingCardState = false;
bool lastEmergencyState = false;

volatile bool triggerEmergencyBlink = false;
volatile bool triggerAddingBlink = false;
volatile bool triggerRegisteredTone = false;
bool blinkState = false;

enum ActionState { IDLE, GREEN_OK, RED_ERR, BLUE_ERR, BLUE_LIMIT };
ActionState currentAction = IDLE;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// async managing diods
void handleEffects() {
  static bool step = false;
  
  if (currentAction == IDLE) return;

  if (currentAction == GREEN_OK) {
    if (timerLedAction == 0) {
      timerLedAction = millis();
      digitalWrite(RED_LED, LOW);
      tone(buzzerPin, 1500);
    }
    if (millis() - timerLedAction >= 1000) {
      digitalWrite(RED_LED, HIGH);
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
      digitalWrite(BLUE_LED_UNKNOWN, HIGH);
      tone(buzzerPin, 100);
    }
    if (millis() - timerLedAction >= 1000) {
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
      digitalWrite(BLUE_LED_UNKNOWN, HIGH);
      tone(buzzerPin, 1500);
    }
    if (diff >= 1000) {
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
  Serial.println(doc["nameEspReader"].as<String>());

  if (topicStr == "skud/control/response" && doc["nameEspReader"].as<String>() == "8C:94:DF:45:F8:B0") {
    String status = doc["status"].as<String>();
    
    if (status == "1") { currentAction = GREEN_OK; }
    else if (status == "404") { currentAction = BLUE_ERR; }
    else if (status == "422") { currentAction = BLUE_LIMIT; }
    else if (status == "0") { currentAction = RED_ERR; }
    else if (status == "registered") {
      tone(buzzerPin, 2000, 200); 
    }
  }
  
  if (topicStr == "skud/control/status") {
    isEmergency = doc["isEmergency"].as<bool>();
    isAddingCard = doc["isAddingCard"].as<bool>();
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

    String clientId = "ESP32_Gate_Main_Lock";

    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("УСПЕШНО");
      mqttClient.subscribe("skud/control/response");
      mqttClient.subscribe("skud/control/status");
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

  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected");

  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512); 
}

void sendHeartbeat() {
  if (!mqttClient.connected()) return;
  JsonDocument doc;
  doc["device_name"] = "ESP32_Gate_Main_Lock";
  doc["connection"] = "true";

  String jsonPayload;
  serializeJson(doc, jsonPayload);
  mqttClient.publish("skud/heartbeat", jsonPayload.c_str());
}

void IRAM_ATTR onEmergencyTicker()  { triggerEmergencyBlink = true; }
void IRAM_ATTR onAddingCardTicker() { triggerAddingBlink = true; }

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
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(BLUE_LED_UNKNOWN, LOW);
    noTone(buzzerPin);
  }
  lastEmergencyState = isEmergency;
  lastAddingCardState = isAddingCard;

  //ticker manager
  if (isEmergency) {
    addingCardTicker.detach();
    if (!emergencyTicker.active()) emergencyTicker.attach(0.5, onEmergencyTicker);
  } else if (isAddingCard) {
    emergencyTicker.detach();
    if (!addingCardTicker.active()) addingCardTicker.attach(1.0, onAddingCardTicker);
  } else {
    emergencyTicker.detach();
    addingCardTicker.detach();
  }

  // emergency
  if (triggerEmergencyBlink) {
    triggerEmergencyBlink = false;
    blinkState = !blinkState;
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RED_LED, blinkState ? LOW : HIGH);
    digitalWrite(BLUE_LED_UNKNOWN, LOW);
    tone(buzzerPin, blinkState ? 1500 : 500, 150);
  }

  // adding card function
  if (triggerAddingBlink) {
    triggerAddingBlink = false;
    blinkState = !blinkState;
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RED_LED, HIGH);
    digitalWrite(BLUE_LED_UNKNOWN, blinkState ? HIGH : LOW);
    if (blinkState) tone(buzzerPin, 1200, 100); 
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
