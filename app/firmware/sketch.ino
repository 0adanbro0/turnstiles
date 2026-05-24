#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <HTTPClient.h>

// WiFi — ОБЯЗАТЕЛЬНО ЗАПОЛНИТЕ ПЕРЕД ПРОШИВКОЙ!
const char* ssid = "s24";
const char* password = "45504550";

// Ссылка на ваш Node.js бэкенд (из настроек docker-compose)
const char* serverURL = "http://10.142.165.220:3000/api/check";
const char* statusURL = "http://10.142.165.220:3000/api/hardware-status";

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

unsigned long timer1 = 0;
unsigned long timer2 = 0;

bool isEmergency = false;
bool lastEmergencyState = false;
bool isProcessingCard = false;

WiFiClient client;
HTTPClient http;

void setup() {
  Serial.begin(115200);

  pinMode(buzzerPin, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BLUE_LED_UNKNOWN, OUTPUT);

  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, HIGH);

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

// GREEN LED, access
void greenSuccess() {
  digitalWrite(RED_LED, LOW);
  tone(buzzerPin, 1500);
  
  delay(1000);
  digitalWrite(RED_LED, HIGH);
  noTone(buzzerPin);
}

// RED LED, denied
void redError() {
  Serial.print("доступ запрещен");
  tone(buzzerPin, 100);
  delay(500);
  noTone(buzzerPin);
}

// BLUE LED, unknown card
void blueError(){
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  tone(buzzerPin, 100);
  Serial.print("неизвестная карта, доступ запрещен");
  delay(1000);
  digitalWrite(BLUE_LED_UNKNOWN, LOW);
  noTone(buzzerPin);
}

// BLUE LED, limit reached
void blueErrorLimit(){
  digitalWrite(BLUE_LED_UNKNOWN, HIGH);
  tone(buzzerPin, 300);
  Serial.print("неизвестная карта, доступ запрещен");
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

// send data in json format
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
  String jsonPayload = "{\"user_id\":\"" + uid + "\",\"direction\":\"" + direction + "\"}";

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
    
    Serial.print("[Фон] Статус: ");
    Serial.println(isEmergency ? "TRUE" : "FALSE");
  }
  http.end();
}

// SCANING
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

  if (response == "1") {
    greenSuccess();
  }
  else if (response == "404") {
    blueError();
  }
  else if (response == "422") {
    blueErrorLimit();
  }
  else if (response == "0") {
    redError();
  }
  else {
    Serial.println("UNKNOWN RESPONSE - NO ACTION");
  }

  reader.PICC_HaltA();

  isProcessingCard = false;
  timer2 = millis();
}

void loop() {
  if (isEmergency != lastEmergencyState) {
    if (!isEmergency) {
      digitalWrite(RED_LED, HIGH);
      digitalWrite(GREEN_LED, HIGH);
      digitalWrite(BLUE_LED_UNKNOWN, LOW);
    }
    lastEmergencyState = isEmergency;
  }

  if (!isEmergency) {
    if (millis() - timer1 >= 20) {
      timer1 = millis();
      checkReader(rfid1, "ENTRANCE");
      checkReader(rfid2, "EXIT");
    }
  } 
  else {
    digitalWrite(GREEN_LED, HIGH);
    tone(buzzerPin, 1500);
    delay(1000);
    tone(buzzerPin, 500);
    delay(300);
    tone(buzzerPin, 2000);
    delay(1000);
    noTone(buzzerPin);
    digitalWrite(RED_LED, LOW);
    digitalWrite(BLUE_LED_UNKNOWN, LOW);
  }

  if (!isProcessingCard && (millis() - timer2 >= 2500)) {
    timer2 = millis();
    checkBackendStatus();
  }

  // Задача 2: отправляет данные в порт каждые 2.5 секунды
  if (!isProcessingCard && (millis() - timer2 >= 2500)) {
    timer2 = millis();
    checkBackendStatus();
  }
}
