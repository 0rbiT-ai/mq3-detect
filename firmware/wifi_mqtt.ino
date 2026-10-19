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
const int SIM800L_RX_PIN = 19;  // SIM800L TXD -> ESP32 RX
const int SIM800L_TX_PIN = 18;  // SIM800L RXD <- ESP32 TX

const char* SENSOR_TOPIC = "vehicle/001/sensors";
const char* BUZZER_COMMAND_TOPIC = "vehicle/001/command/buzzer";
const char* SIM800L_SMS_COMMAND_TOPIC = "vehicle/001/command/sms";

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
HardwareSerial gpsSerial(2);
HardwareSerial sim800Serial(1);
TinyGPSPlus gps;
bool buzzerOn = false;

enum Sim800SmsState { SMS_IDLE, SMS_WAIT_TEXT_MODE, SMS_WAIT_PROMPT, SMS_WAIT_RESULT };
Sim800SmsState sim800SmsState = SMS_IDLE;
String sim800SmsRecipient;
String sim800SmsBody;
String sim800Response;
unsigned long sim800StateStartedAt = 0;
bool sim800SawMessageReference = false;

void finishSim800Sms(bool success, const char* reason) {
  Serial.printf("SIM800L SMS %s: %s\n", success ? "accepted by modem" : "failed", reason);
  sim800SmsState = SMS_IDLE;
  sim800SmsRecipient = "";
  sim800SmsBody = "";
  sim800Response = "";
  sim800SawMessageReference = false;
}

void queueSim800Sms(String command) {
  if (sim800SmsState != SMS_IDLE) {
    Serial.println("SIM800L SMS command ignored: modem is already sending a message.");
    return;
  }

  int firstSeparator = command.indexOf('|');
  int secondSeparator = command.indexOf('|', firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) {
    Serial.println("SIM800L SMS command ignored: expected raw|threshold|recipient.");
    return;
  }

  String raw = command.substring(0, firstSeparator);
  String threshold = command.substring(firstSeparator + 1, secondSeparator);
  String recipient = command.substring(secondSeparator + 1);
  recipient.trim();
  bool validRecipient = recipient.length() >= 10 && recipient.length() <= 15;
  for (unsigned int i = 0; i < recipient.length(); i++) {
    if (!isDigit(recipient[i])) validRecipient = false;
  }
  if (!validRecipient) {
    Serial.println("SIM800L SMS command ignored: recipient must contain 10 to 15 digits including country code.");
    return;
  }

  sim800SmsRecipient = "+" + recipient;
  sim800SmsBody = "Prototype sensor alert: MQ-3 raw reading " + raw +
                  " crossed demo threshold " + threshold +
                  ". This uncalibrated reading is not a BAC measurement.";
  sim800Response = "";
  sim800SawMessageReference = false;
  sim800Serial.println("AT+CMGF=1");
  sim800SmsState = SMS_WAIT_TEXT_MODE;
  sim800StateStartedAt = millis();
  Serial.printf("SIM800L SMS queued for configured recipient (raw=%s, threshold=%s).\n",
                raw.c_str(), threshold.c_str());
}

void pollSim800Sms() {
  while (sim800Serial.available()) {
    char c = static_cast<char>(sim800Serial.read());
    if (sim800SmsState == SMS_WAIT_PROMPT && c == '>') {
      sim800Serial.print(sim800SmsBody);
      sim800Serial.write(26);  // Ctrl+Z submits the SMS to the modem.
      sim800Response = "";
      sim800SmsState = SMS_WAIT_RESULT;
      sim800StateStartedAt = millis();
      continue;
    }
    if (sim800Response.length() < 500) sim800Response += c;
  }

  if (sim800SmsState == SMS_IDLE) return;
  if (sim800Response.indexOf("ERROR") >= 0 || sim800Response.indexOf("+CMS ERROR") >= 0) {
    finishSim800Sms(false, "modem returned an error; check SIM, signal, and SMS service");
    return;
  }

  if (sim800SmsState == SMS_WAIT_TEXT_MODE && sim800Response.indexOf("OK") >= 0) {
    sim800Response = "";
    sim800Serial.print("AT+CMGS=\"");
    sim800Serial.print(sim800SmsRecipient);
    sim800Serial.println("\"");
    sim800SmsState = SMS_WAIT_PROMPT;
    sim800StateStartedAt = millis();
  } else if (sim800SmsState == SMS_WAIT_RESULT) {
    if (sim800Response.indexOf("+CMGS:") >= 0) sim800SawMessageReference = true;
    if (sim800SawMessageReference && sim800Response.indexOf("OK") >= 0) {
      finishSim800Sms(true, "modem accepted the message");
      return;
    }
  }

  unsigned long timeout = sim800SmsState == SMS_WAIT_RESULT ? 30000UL : 10000UL;
  if (millis() - sim800StateStartedAt > timeout) {
    finishSim800Sms(false, "timed out waiting for modem response");
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  String command;
  command.reserve(length);
  for (unsigned int i = 0; i < length; i++) command += static_cast<char>(payload[i]);

  if (strcmp(topic, SIM800L_SMS_COMMAND_TOPIC) == 0) {
    queueSim800Sms(command);
    return;
  }
  if (strcmp(topic, BUZZER_COMMAND_TOPIC) != 0) return;

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

  sim800Serial.begin(9600, SERIAL_8N1, SIM800L_RX_PIN, SIM800L_TX_PIN);
  Serial.println("SIM800L UART started at 9600 baud (RX=GPIO19, TX=GPIO18)");
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
      if (mqtt.subscribe(SIM800L_SMS_COMMAND_TOPIC)) {
        Serial.printf("Subscribed to %s\n", SIM800L_SMS_COMMAND_TOPIC);
      } else {
        Serial.println("Failed to subscribe to SIM800L SMS commands");
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
  pollSim800Sms();

  static unsigned long lastPublish = 0;

  if (millis() - lastPublish >= 5000) {
    lastPublish = millis();

  int raw = analogRead(MQ3_PIN);
  int mv = analogReadMilliVolts(MQ3_PIN);
  // GPIO 32 is seatbelt status (display only); GPIO 33 indicates driver presence.
  bool seatbeltFastened = digitalRead(BUTTON1_PIN) == LOW;
  bool driverPresent = digitalRead(BUTTON2_PIN) == LOW;
  bool gpsValid = gps.location.isValid() && gps.location.age() < 10000;

  char payload[320];
  if (gpsValid) {
    snprintf(payload, sizeof(payload),
             "{\"status\":\"online\",\"mq3_raw\":%d,\"mq3_mV\":%d,"
             "\"seatbelt_fastened\":%s,\"driver_present\":%s,"
             "\"buzzer_on\":%s,\"gps_valid\":true,\"latitude\":%.6f,\"longitude\":%.6f}",
             raw, mv,
             seatbeltFastened ? "true" : "false",
             driverPresent ? "true" : "false",
             buzzerOn ? "true" : "false",
             gps.location.lat(), gps.location.lng());
  } else {
    snprintf(payload, sizeof(payload),
             "{\"status\":\"online\",\"mq3_raw\":%d,\"mq3_mV\":%d,"
             "\"seatbelt_fastened\":%s,\"driver_present\":%s,"
             "\"buzzer_on\":%s,\"gps_valid\":false,\"latitude\":null,\"longitude\":null}",
             raw, mv,
             seatbeltFastened ? "true" : "false",
             driverPresent ? "true" : "false",
             buzzerOn ? "true" : "false");
  }

  bool sent = mqtt.publish(SENSOR_TOPIC, payload);
  Serial.printf("MQ3=%d (%d mV), seatbelt=%d driverPresent=%d GPS=%s buzzer=%d; MQTT %s\n",
                raw, mv, seatbeltFastened, driverPresent,
                gpsValid ? "FIX" : "NO FIX", buzzerOn,
                sent ? "OK" : "FAILED");
  }
}
