#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Ticker.h>

Ticker emergencyTicker;
Ticker addingCardTicker;

const char* ssid = "s24";
const char* password = "45504550";
const String ipv4 = "10.25.77.220";

const String serverURL = "http://"+ ipv4 +":3000/api/check";
const String statusURL = "http://"+ ipv4 +":3000/api/hardware-status";
const String addingCardURL = "http://"+ ipv4 +":3000/api/adding-card";
const String wifiStatusURL = "http://"+ ipv4 +":3000/api/connection-to-server"; 

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
unsigned long timerSendConnection = 0;
unsigned long timerStatus = 0;
unsigned long timerAdding = 0;

bool isEmergency = false;
bool isAddingCard = false;
bool lastAddingCardState = false;
bool lastEmergencyState = false;
bool isProcessingCard = false;
bool blinkState = false;

WiFiClient client;
HTTPClient http;

void sendWifiReadyStatus() {
  if (WiFi.status() == WL_CONNECTED) {
    http.begin(client, wifiStatusURL);
    http.addHeader("Content-Type", "application/json");
    String payload = "{\"device_name\":\"ESP32_Gate_CARD_Main\",\"connection\":\"true\"}";
    int code = http.POST(payload);
    Serial.print("[WiFi-Status] Данные отправлены. Код: ");
    Serial.println(code);
    http.end();
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
  Serial.print("доступ запрещен");
  tone(buzzerPin, 100);
  delay(500);
  noTone(buzzerPin);
}

void blueError(){
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  tone(buzzerPin, 100);
  Serial.print("неизвестная карта, доступ запрещен");
  delay(1000);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);
  noTone(buzzerPin);
}

void blueErrorLimit(){
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  tone(buzzerPin, 300);
  delay(500);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);
  noTone(buzzerPin);
  delay(200);
  tone(buzzerPin, 1500);
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  delay(500);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);
  noTone(buzzerPin);
}

String sendToServer(String uid, String gate) {
  if(isEmergency){
    return "ALERT : EMERGENCY SITUATION!!!";
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected! Cannot send request.");
    return "ERROR";
  }

  http.begin(client, serverURL);
  http.addHeader("Content-Type", "application/json");

  String direction = (gate == "ENTRANCE") ? "in" : "out";
  String jsonPayload = "{\"user_id\":\"" + uid + "\",\"direction\":\"" + direction + "\",\"isAddingCardStatus\":\"" + isAddingCard + "\"}";

  int code = http.POST(jsonPayload);
  String response = "";

  Serial.println("\n--- SERVER RESPONSE ---");
  Serial.println("Code: " + String(code));

  if (code > 0) {
    response = http.getString();
    Serial.println("Response: " + response);
  } else {
    Serial.print("Connection failed! Error: ");
    Serial.println(http.errorToString(code).c_str());
    response = "ERROR"; 
  }
  
  Serial.println("-----------------------");

  http.end();
  response.trim(); 
  return response;
}

void checkBackendStatus() {
  if (WiFi.status() != WL_CONNECTED) return;

  http.begin(client, statusURL);
  http.addHeader("Connection", "keep-alive");
  int code = http.GET();

  if (code == 200) {
    String response = http.getString();
    response.trim();
    isEmergency = (response == "true" || response == "1");
    
    Serial.print("[Фон] Статус Тревоги: ");
    Serial.println(isEmergency ? "TRUE" : "FALSE");
  }
  http.end();
}

void checkAddingCardStatus() {
  if (WiFi.status() != WL_CONNECTED) return;

  http.begin(client, addingCardURL);
  http.addHeader("Connection", "keep-alive");
  int code = http.GET();

  if (code == 200) {
    String response = http.getString();
    response.trim();
    isAddingCard = (response == "true" || response == "1");
    
    Serial.print("[Фон] Статус Добавления: ");
    Serial.println(isAddingCard ? "TRUE" : "FALSE");
  }
  http.end();
}

void checkReader(MFRC522 &reader, String gate) {
  if (!reader.PICC_IsNewCardPresent() || !reader.PICC_ReadCardSerial()) return;

  isProcessingCard = true;
  String uid = "";

  for (byte i = 0; i < reader.uid.size; i++) {
    uid += (reader.uid.uidByte[i] < 0x10 ? "0" : "");
    uid += String(reader.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  Serial.println("\nSCAN: " + uid + " (" + gate + ")");
  String response = sendToServer(uid, gate);

  if (response == "1") { greenSuccess(); }
  else if (response == "404") { blueError(); }
  else if (response == "422") { blueErrorLimit(); }
  else if (response == "0") { redError(); }
  else { Serial.println("UNKNOWN RESPONSE - NO ACTION"); }

  reader.PICC_HaltA();
  isProcessingCard = false;
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
  }else {
    emergencyTicker.detach();
    addingCardTicker.detach();
    noTone(buzzerPin);
    digitalWrite(RED_LED, HIGH); 
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(BLUE_LED_UNKNOWN, LOW);
  }

  if (!isProcessingCard) {
    if (millis() - timerStatus >= 2500) {
      timerStatus = millis();
      checkBackendStatus();
    }
    
    if (millis() - timerAdding >= 3000) {
      timerAdding = millis();
      checkAddingCardStatus();
    }
  }

  if (millis() - timerSendConnection >= 5000) {
    timerSendConnection = millis();
    sendWifiReadyStatus();
  }
}
