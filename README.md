# Alcohol-sensor MQ3 alert prototype

The repository now separates the MQTT/WebSocket backend, the Expo Go mobile app, ESP32 firmware, and Mosquitto configuration.

```text
backend/       Express + MQTT + WebSocket + threshold/WhatsApp alert logic
frontend/      React Native app for Expo Go
firmware/      ESP32 Arduino sketch
config/        Mosquitto LAN listener configuration
```

## Start the data path

1. Start Mosquitto with `config/mosquitto-lan.conf` and keep that terminal open.
2. In `backend`, copy `.env.example` to `.env.local`, then set `MQTT_URL` to the laptop's current LAN IPv4 address. Run `npm start`.
3. In `frontend/.env.local`, set `EXPO_PUBLIC_WS_URL` to `ws://<laptop-lan-ip>:8080/ws`.
4. In Arduino IDE, edit the Wi-Fi SSID/password and MQTT host in `firmware/wifi_mqtt.ino`, then flash the ESP32.
5. Run `npm start` in `frontend`, scan the Expo Go QR code, and keep the phone and laptop on the same LAN. Windows Firewall may ask to allow Node.js on the private network.

The Node process subscribes to `vehicle/001/sensors` itself. A separate `mosquitto_sub` terminal is optional for debugging only.

## Threshold and buzzer

`backend/.env.local` contains `MQ3_THRESHOLD_RAW=490`. Change that number to edit the raw ADC trigger. When a telemetry reading reaches or exceeds it, the backend publishes `ON` to `vehicle/001/command/buzzer`; when the reading falls below it, it publishes `OFF`. The backend locks the app's manual OFF command while the threshold alarm is active.

The MQ-3 reading is an uncalibrated raw ADC value, not alcohol concentration or BAC. A threshold of 490 is only a prototype demonstration trigger and can produce false alarms. Do not use it to determine whether someone can drive.

## WhatsApp recipient and setup

The recipient is whichever single phone number you put in `WHATSAPP_TO` in `backend/.env.local`, with country code (digits only is easiest, for example `91...`). Choose your own WhatsApp number for initial testing, or a consenting contact who should receive the test alert. The server does not guess a recipient or take it from the mobile app.

To activate sending, create/configure a WhatsApp Business Cloud API app in Meta, set the API version, phone-number ID, access token, recipient number, and an approved template name/language in the local env file, then set `WHATSAPP_ENABLED=true`. The template should have two body placeholders in order: the measured raw count (`{{1}}`) and configured trigger (`{{2}}`). The code sends an approved template when the threshold first crosses, not on every five-second reading. Meta requires a valid template for a business-initiated alert. Keep the access token private and do not commit `.env.local`.

## Network notes

`192.168.29.88` is the prior laptop address; update it if DHCP changes it. The laptop, ESP32, and phone need to reach one another over the same local network for this prototype. Do not expose the MQTT broker, backend, or access token to the public internet.
