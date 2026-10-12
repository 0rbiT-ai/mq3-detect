#include <WiFi.h>
#include <PubSubClient.h>
#include <TinyGPS++.h>
#include <string.h>

// Enter these locally before flashing. Do not commit real network credentials.
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

const char* mqttHost = "192.168.29.88";

// Pins from the project handover.
const int MQ3_PIN = 34;
const int GPS_RX_PIN = 16;  // GPS TX -> ESP32 RX
const int GPS_TX_PIN = 17;  // GPS RX <- ESP32 TX
const int BUTTON1_PIN = 32;
const int BUTTON2_PIN = 33;
const int BUZZER_PIN = 25;

const char* SENSOR_TOPIC = "vehicle/001/sensors";
const char* BUZZER_COMMAND_TOPIC = "vehicle/001/command/buzzer";

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
HardwareSerial gpsSerial(2);
TinyGPSPlus gps;
bool buzzerOn = false;

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, BUZZER_COMMAND_TOPIC) != 0) return;

  String command;
  command.reserve(length);
  for (unsigned int i = 0; i < length; i++) command += static_cast<char>(payload[i]);
  command.trim();
  command.toUpperCase();

  if (command == "ON") {
    buzzerOn = true;
  } else if (command == "OFF") {
    buzzerOn = false;
  } else {
    Serial.println("Ignored buzzer command; expected ON or OFF");
    return;
  }

  digitalWrite(BUZZER_PIN, buzzerOn ? HIGH : LOW);
  Serial.printf("Buzzer %s\n", buzzerOn ? "ON" : "OFF");
}

void setup() {
  Serial.begin(115200);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to Wi-Fi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWi-Fi connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());

  mqtt.setServer(mqttHost, 1883);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);

  analogReadResolution(12);
  analogSetPinAttenuation(MQ3_PIN, ADC_11db);

  pinMode(BUTTON1_PIN, INPUT_PULLUP);
  pinMode(BUTTON2_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("GPS UART started at 9600 baud (RX=GPIO16, TX=GPIO17)");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(ssid, password);
    delay(1000);
    return;
  }

  if (!mqtt.connected()) {
    Serial.print("Connecting to MQTT...");
    if (mqtt.connect("esp32-alcohol-device")) {
      Serial.println("connected");
      if (mqtt.subscribe(BUZZER_COMMAND_TOPIC)) {
        Serial.printf("Subscribed to %s\n", BUZZER_COMMAND_TOPIC);
      } else {
        Serial.println("Failed to subscribe to buzzer commands");
      }
    } else {
      Serial.print("failed, state=");
      Serial.println(mqtt.state());
      delay(3000);
      return;
    }
  }

  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  mqtt.loop();

  static unsigned long lastPublish = 0;

  if (millis() - lastPublish >= 5000) {
    lastPublish = millis();

  int raw = analogRead(MQ3_PIN);
  int mv = analogReadMilliVolts(MQ3_PIN);
  bool button1Pressed = digitalRead(BUTTON1_PIN) == LOW;
  bool button2Pressed = digitalRead(BUTTON2_PIN) == LOW;
  bool armed = button1Pressed && button2Pressed;
  bool gpsValid = gps.location.isValid() && gps.location.age() < 10000;

  char payload[320];
  if (gpsValid) {
    snprintf(payload, sizeof(payload),
             "{\"status\":\"online\",\"mq3_raw\":%d,\"mq3_mV\":%d,"
             "\"button1_pressed\":%s,\"button2_pressed\":%s,\"armed\":%s,"
             "\"buzzer_on\":%s,\"gps_valid\":true,\"latitude\":%.6f,\"longitude\":%.6f}",
             raw, mv,
             button1Pressed ? "true" : "false",
             button2Pressed ? "true" : "false",
             armed ? "true" : "false",
             buzzerOn ? "true" : "false",
             gps.location.lat(), gps.location.lng());
  } else {
    snprintf(payload, sizeof(payload),
             "{\"status\":\"online\",\"mq3_raw\":%d,\"mq3_mV\":%d,"
             "\"button1_pressed\":%s,\"button2_pressed\":%s,\"armed\":%s,"
             "\"buzzer_on\":%s,\"gps_valid\":false,\"latitude\":null,\"longitude\":null}",
             raw, mv,
             button1Pressed ? "true" : "false",
             button2Pressed ? "true" : "false",
             armed ? "true" : "false",
             buzzerOn ? "true" : "false");
  }

  bool sent = mqtt.publish(SENSOR_TOPIC, payload);
  Serial.printf("MQ3=%d (%d mV), B1=%d B2=%d armed=%d GPS=%s buzzer=%d; MQTT %s\n",
                raw, mv, button1Pressed, button2Pressed, armed,
                gpsValid ? "FIX" : "NO FIX", buzzerOn,
                sent ? "OK" : "FAILED");
  }
}
