import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Telemetry = {
  status?: string;
  mq3_raw?: number;
  mq3_mV?: number;
  seatbelt_fastened?: boolean;
  driver_present?: boolean;
  // Compatibility with telemetry from firmware uploaded before this change.
  button1_pressed?: boolean;
  button2_pressed?: boolean;
  buzzer_on?: boolean;
  gps_valid?: boolean;
  latitude?: number | null;
  longitude?: number | null;
};

type ServerState = {
  type: string;
  mqttConnected: boolean;
  threshold: number;
  alarmActive: boolean;
  buzzerOn: boolean;
  lastAlertAt: string | null;
  updatedAt: string | null;
  telemetry: Telemetry | null;
  topic: string;
  message?: string;
};

const SOCKET_URL = process.env.EXPO_PUBLIC_WS_URL || "ws://192.168.29.88:8080/ws";
const EMPTY_STATE: ServerState = {
  type: "state",
  mqttConnected: false,
  threshold: 490,
  alarmActive: false,
  buzzerOn: false,
  lastAlertAt: null,
  updatedAt: null,
  telemetry: null,
  topic: "vehicle/001/sensors",
};

export default function MonitorScreen() {
  const [serverState, setServerState] = useState(EMPTY_STATE);
  const [socketOpen, setSocketOpen] = useState(false);
  const [socketError, setSocketError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const telemetry = serverState.telemetry;

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closedByUnmount = false;

    const connect = () => {
      if (closedByUnmount) return;
      setSocketError("");
      const socket = new WebSocket(SOCKET_URL);
      socketRef.current = socket;

      socket.onopen = () => setSocketOpen(true);
      socket.onmessage = (event) => {
        try {
          const packet = JSON.parse(String(event.data)) as ServerState;
          if (packet.type === "state") setServerState(packet);
          if (packet.type === "error") setSocketError(packet.message || "The server rejected the command.");
        } catch {
          setSocketError("Received an unreadable message from the backend.");
        }
      };
      socket.onerror = () => setSocketError("Could not reach the backend. Check that the phone and laptop share Wi-Fi.");
      socket.onclose = () => {
        setSocketOpen(false);
        socketRef.current = null;
        if (!closedByUnmount) retryTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      closedByUnmount = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const sendBuzzer = useCallback((enabled: boolean) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setSocketError("Reconnect to the backend before sending a buzzer command.");
      return;
    }
    setSocketError("");
    socketRef.current.send(JSON.stringify({ type: "buzzer", enabled }));
  }, []);

  const gpsCoordinates = useMemo(() => {
    const valid = telemetry?.gps_valid === true
      && typeof telemetry.latitude === "number"
      && typeof telemetry.longitude === "number";
    if (!valid) return null;
    return { latitude: telemetry.latitude as number, longitude: telemetry.longitude as number };
  }, [telemetry]);

  const openMap = useCallback(() => {
    if (!gpsCoordinates) return;
    void Linking.openURL(`https://maps.google.com/?q=${gpsCoordinates.latitude},${gpsCoordinates.longitude}`);
  }, [gpsCoordinates]);

  const raw = telemetry?.mq3_raw;
  const driverPresent = telemetry?.driver_present ?? telemetry?.button2_pressed;
  const seatbeltFastened = telemetry?.seatbelt_fastened ?? telemetry?.button1_pressed;
  const thresholdExceeded = typeof raw === "number" && raw >= serverState.threshold;
  const progress = typeof raw === "number" ? Math.min(1, raw / Math.max(1, serverState.threshold)) : 0;
  const lastSeen = serverState.updatedAt ? new Date(serverState.updatedAt).toLocaleTimeString() : "Waiting for first reading";

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.header}>
          <View style={styles.brandMark}><View style={styles.brandBar} /><View style={styles.brandBarShort} /></View>
          <View style={styles.headerCopy}>
            <Text style={styles.kicker}>ROADWATCH / NODE 001</Text>
            <Text style={styles.title}>Live monitor</Text>
          </View>
          <View style={[styles.connection, socketOpen && serverState.mqttConnected ? styles.connectionLive : styles.connectionOff]}>
            <View style={[styles.connectionDot, socketOpen && serverState.mqttConnected ? styles.dotLive : styles.dotOff]} />
            <Text style={[styles.connectionText, socketOpen && serverState.mqttConnected ? styles.textLive : styles.textOff]}>
              {socketOpen ? (serverState.mqttConnected ? "LIVE" : "NO BROKER") : "OFFLINE"}
            </Text>
          </View>
        </View>

        <Text style={styles.intro}>Sensor readings and vehicle safety inputs from the ESP32.</Text>

        {serverState.alarmActive && (
          <View style={styles.alarmBanner} accessibilityRole="alert">
            <Text style={styles.alarmTitle}>Threshold reached</Text>
            <Text style={styles.alarmCopy}>Driver present and the raw reading reached the prototype threshold. Check the reading and device.</Text>
          </View>
        )}

        <View style={[styles.readingPanel, serverState.alarmActive && styles.readingPanelAlarm]}>
          <View style={styles.panelHeadingRow}>
            <View>
              <Text style={styles.sectionEyebrow}>MQ-3 SENSOR</Text>
              <Text style={styles.readingTitle}>Raw signal</Text>
            </View>
            <View style={[styles.stateTag, serverState.alarmActive ? styles.tagAlarm : styles.tagNormal]}>
              <Text style={[styles.stateTagText, serverState.alarmActive ? styles.tagAlarmText : styles.tagNormalText]}>
                {serverState.alarmActive ? "TRIGGERED" : driverPresent === false && thresholdExceeded ? "DRIVER ABSENT" : "BELOW TRIGGER"}
              </Text>
            </View>
          </View>
          <View style={styles.valueLine}>
            <Text style={styles.rawValue}>{typeof raw === "number" ? raw : "—"}</Text>
            <Text style={styles.rawUnit}>ADC counts</Text>
          </View>
          <View style={styles.meterTrack}>
            <View style={[styles.meterFill, serverState.alarmActive && styles.meterFillAlarm, { width: `${Math.round(progress * 100)}%` }]} />
            <View style={[styles.thresholdTick, { left: "99%" }]} />
          </View>
          <View style={styles.thresholdRow}>
            <Text style={styles.mutedText}>Trigger at <Text style={styles.thresholdNumber}>{serverState.threshold}</Text></Text>
            <Text style={styles.mutedText}>{typeof raw === "number" ? `${Math.max(0, serverState.threshold - raw)} counts to trigger` : "No reading yet"}</Text>
          </View>
          <View style={styles.readingDivider} />
          <View style={styles.measureRow}>
            <Text style={styles.measureLabel}>ESP32 input</Text>
            <Text style={styles.measureValue}>{typeof telemetry?.mq3_mV === "number" ? `${telemetry.mq3_mV} mV` : "—"}</Text>
          </View>
          <Text style={styles.caution}>Raw ADC trigger for this prototype only. It is not a calibrated alcohol concentration or BAC measurement.</Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Position</Text>
          <Text style={styles.sectionMeta}>{gpsCoordinates ? "GPS FIX" : "NO FIX"}</Text>
        </View>
        <View style={styles.positionPanel}>
          <View style={styles.gpsStatusRow}>
            <View style={[styles.gpsSymbol, gpsCoordinates ? styles.gpsSymbolOn : styles.gpsSymbolOff]}>
              <View style={[styles.gpsSymbolCore, gpsCoordinates ? styles.gpsCoreOn : styles.gpsCoreOff]} />
            </View>
            <View style={styles.gpsCopy}>
              <Text style={styles.gpsTitle}>{gpsCoordinates ? "Coordinates received" : "Waiting for satellites"}</Text>
              <Text style={styles.gpsSubtitle}>{gpsCoordinates ? "Latest fix from the NEO-6M" : "Take the antenna outdoors with a clear view of the sky."}</Text>
            </View>
          </View>
          <View style={styles.coordinateGrid}>
            <View style={styles.coordinateCell}>
              <Text style={styles.coordinateLabel}>LATITUDE</Text>
              <Text style={styles.coordinateValue}>{gpsCoordinates ? gpsCoordinates.latitude.toFixed(6) : "—"}</Text>
            </View>
            <View style={styles.coordinateCell}>
              <Text style={styles.coordinateLabel}>LONGITUDE</Text>
              <Text style={styles.coordinateValue}>{gpsCoordinates ? gpsCoordinates.longitude.toFixed(6) : "—"}</Text>
            </View>
          </View>
          <Pressable onPress={openMap} disabled={!gpsCoordinates} style={({ pressed }) => [styles.mapButton, !gpsCoordinates && styles.buttonDisabled, pressed && gpsCoordinates && styles.pressed]}>
            <Text style={[styles.mapButtonText, !gpsCoordinates && styles.disabledText]}>{gpsCoordinates ? "Open location in Maps" : "Map opens when GPS has a fix"}</Text>
            <Text style={[styles.mapArrow, !gpsCoordinates && styles.disabledText]}>↗</Text>
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Safety inputs</Text>
          <View style={[styles.armedTag, driverPresent ? styles.armedOn : styles.armedOff]}>
            <Text style={[styles.armedText, driverPresent ? styles.armedTextOn : styles.armedTextOff]}>
              {typeof driverPresent !== "boolean" ? "WAITING" : driverPresent ? "SEATED" : "UNOCCUPIED"}
            </Text>
          </View>
        </View>
        <View style={styles.inputPanel}>
          <InputRow label="Seatbelt" pin="GPIO 32" pressed={seatbeltFastened} activeLabel="FASTENED" inactiveLabel="UNFASTENED" />
          <View style={styles.rowDivider} />
          <InputRow label="Driver seat" pin="GPIO 33" pressed={driverPresent} activeLabel="OCCUPIED" inactiveLabel="EMPTY" />
        </View>
        <Text style={styles.helperText}>Alcohol alerts and the buzzer activate only when the driver is seated and the reading reaches the threshold. Seatbelt status is display only.</Text>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Buzzer</Text>
          <Text style={styles.sectionMeta}>GPIO 25</Text>
        </View>
        <View style={styles.buzzerPanel}>
          <View style={styles.buzzerStatusRow}>
            <View style={[styles.buzzerIndicator, serverState.buzzerOn ? styles.buzzerIndicatorOn : styles.buzzerIndicatorOff]} />
            <View style={styles.buzzerCopy}>
              <Text style={styles.buzzerTitle}>{telemetry ? (serverState.buzzerOn ? "Sounding" : "Silent") : "No device status"}</Text>
              <Text style={styles.gpsSubtitle}>{serverState.alarmActive ? "Threshold alarm; turn-off is locked until reading drops." : "Manual test controls"}</Text>
            </View>
          </View>
          <View style={styles.controlRow}>
            <Pressable disabled={!socketOpen || serverState.alarmActive} onPress={() => sendBuzzer(false)} style={({ pressed }) => [styles.secondaryButton, (!socketOpen || serverState.alarmActive) && styles.buttonDisabled, pressed && socketOpen && !serverState.alarmActive && styles.pressed]}>
              <Text style={[styles.secondaryButtonText, (!socketOpen || serverState.alarmActive) && styles.disabledText]}>Turn off</Text>
            </Pressable>
            <Pressable disabled={!socketOpen} onPress={() => sendBuzzer(true)} style={({ pressed }) => [styles.primaryButton, !socketOpen && styles.primaryDisabled, pressed && socketOpen && styles.pressed]}>
              <Text style={styles.primaryButtonText}>Test buzzer</Text>
            </Pressable>
          </View>
          {socketError ? <Text style={styles.errorText}>{socketError}</Text> : null}
        </View>

        <View style={styles.footerInfo}>
          <View style={styles.footerLine}><Text style={styles.footerLabel}>MQTT</Text><Text style={styles.footerValue}>{serverState.mqttConnected ? "Connected" : "Disconnected"} · {serverState.topic}</Text></View>
          <View style={styles.footerLine}><Text style={styles.footerLabel}>UPDATED</Text><Text style={styles.footerValue}>{lastSeen}</Text></View>
          <View style={styles.footerLine}><Text style={styles.footerLabel}>ALERT</Text><Text style={styles.footerValue}>{serverState.lastAlertAt ? new Date(serverState.lastAlertAt).toLocaleString() : "No WhatsApp alert sent"}</Text></View>
          {!telemetry && <View style={styles.loadingRow}><ActivityIndicator size="small" color="#236B55" /><Text style={styles.loadingText}>Waiting for ESP32 telemetry</Text></View>}
        </View>
        <Text style={styles.disclaimer}>Prototype monitor only. Do not use these readings to make driving, medical, or legal decisions.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function InputRow({ label, pin, pressed, activeLabel, inactiveLabel }: { label: string; pin: string; pressed?: boolean; activeLabel: string; inactiveLabel: string }) {
  const state = typeof pressed !== "boolean" ? "WAITING" : pressed ? activeLabel : inactiveLabel;
  const active = pressed === true;
  return (
    <View style={styles.inputRow}>
      <View style={[styles.inputMarker, active ? styles.inputMarkerOn : styles.inputMarkerOff]} />
      <View style={styles.inputNameGroup}>
        <Text style={styles.inputName}>{label}</Text>
        <Text style={styles.inputPin}>{pin}</Text>
      </View>
      <Text style={[styles.inputState, active ? styles.inputStateOn : styles.inputStateOff]}>{state}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F4F3ED" },
  page: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 38, maxWidth: 720, width: "100%", alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  brandMark: { width: 38, height: 38, borderRadius: 9, backgroundColor: "#173D33", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 4, marginRight: 11 },
  brandBar: { width: 5, height: 18, borderRadius: 2, backgroundColor: "#F3A34D" },
  brandBarShort: { width: 5, height: 12, borderRadius: 2, backgroundColor: "#E9E7D9" },
  headerCopy: { flex: 1 },
  kicker: { color: "#53655F", fontSize: 10, letterSpacing: 1.1, fontWeight: "700" },
  title: { marginTop: 3, color: "#172A24", fontSize: 22, lineHeight: 26, fontWeight: "700", letterSpacing: -0.5 },
  connection: { minHeight: 30, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  connectionLive: { backgroundColor: "#E3F1E9", borderColor: "#A7CEB7" },
  connectionOff: { backgroundColor: "#F0EDE4", borderColor: "#D7D1BF" },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  dotLive: { backgroundColor: "#237451" },
  dotOff: { backgroundColor: "#9A6B28" },
  connectionText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  textLive: { color: "#205C42" },
  textOff: { color: "#73551D" },
  intro: { color: "#53615B", fontSize: 13, lineHeight: 19, marginBottom: 22 },
  alarmBanner: { padding: 14, borderWidth: 1, borderColor: "#D78058", backgroundColor: "#FFF0E7", borderRadius: 9, marginBottom: 16 },
  alarmTitle: { color: "#8B321C", fontSize: 15, fontWeight: "700" },
  alarmCopy: { color: "#743D2E", fontSize: 13, lineHeight: 19, marginTop: 4 },
  readingPanel: { backgroundColor: "#173D33", borderRadius: 12, padding: 18, marginBottom: 24 },
  readingPanelAlarm: { backgroundColor: "#542E22" },
  panelHeadingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  sectionEyebrow: { color: "#B6C9BF", fontSize: 10, letterSpacing: 1.2, fontWeight: "700" },
  readingTitle: { color: "#F4F2E9", fontSize: 18, fontWeight: "600", marginTop: 4 },
  stateTag: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1 },
  tagNormal: { backgroundColor: "#214D40", borderColor: "#5B8A74" },
  tagAlarm: { backgroundColor: "#6D3929", borderColor: "#D78058" },
  stateTagText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.55 },
  tagNormalText: { color: "#D4E8DA" },
  tagAlarmText: { color: "#FFE4D4" },
  valueLine: { flexDirection: "row", alignItems: "baseline", marginTop: 14 },
  rawValue: { color: "#F7F3E8", fontSize: 56, lineHeight: 62, fontWeight: "700", letterSpacing: -1.5, fontVariant: ["tabular-nums"] },
  rawUnit: { color: "#C1D1C8", fontSize: 13, marginLeft: 9 },
  meterTrack: { marginTop: 13, height: 7, borderRadius: 4, backgroundColor: "#36594D", overflow: "hidden", position: "relative" },
  meterFill: { height: 7, borderRadius: 4, backgroundColor: "#F3A34D" },
  meterFillAlarm: { backgroundColor: "#FFB18A" },
  thresholdTick: { position: "absolute", top: -2, width: 2, height: 11, backgroundColor: "#F4F2E9" },
  thresholdRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 },
  mutedText: { color: "#C1D1C8", fontSize: 11 },
  thresholdNumber: { color: "#F4F2E9", fontWeight: "700", fontVariant: ["tabular-nums"] },
  readingDivider: { height: 1, backgroundColor: "#456458", marginVertical: 15 },
  measureRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  measureLabel: { color: "#C1D1C8", fontSize: 12 },
  measureValue: { color: "#F4F2E9", fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  caution: { color: "#C1D1C8", fontSize: 11, lineHeight: 16, marginTop: 14 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 9 },
  sectionTitle: { color: "#1B3028", fontSize: 16, fontWeight: "700" },
  sectionMeta: { color: "#64736C", fontSize: 10, fontWeight: "700", letterSpacing: 0.75 },
  positionPanel: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#DCDDD3", borderRadius: 10, padding: 15, marginBottom: 23 },
  gpsStatusRow: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  gpsSymbol: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", marginRight: 11 },
  gpsSymbolOn: { backgroundColor: "#E3F1E9" },
  gpsSymbolOff: { backgroundColor: "#EFEDE6" },
  gpsSymbolCore: { width: 12, height: 12, borderRadius: 6 },
  gpsCoreOn: { backgroundColor: "#237451" },
  gpsCoreOff: { backgroundColor: "#918D7F" },
  gpsCopy: { flex: 1 },
  gpsTitle: { color: "#1D3029", fontSize: 14, fontWeight: "600" },
  gpsSubtitle: { color: "#5F6D66", fontSize: 11, lineHeight: 16, marginTop: 3 },
  coordinateGrid: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#E5E5DD", borderBottomWidth: 1, borderBottomColor: "#E5E5DD" },
  coordinateCell: { flex: 1, paddingVertical: 11 },
  coordinateLabel: { color: "#68766F", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 },
  coordinateValue: { color: "#1A332A", fontSize: 14, fontWeight: "600", marginTop: 5, fontVariant: ["tabular-nums"] },
  mapButton: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12, minHeight: 38, paddingHorizontal: 11, backgroundColor: "#EFF4EF", borderRadius: 6 },
  mapButtonText: { color: "#205D44", fontSize: 12, fontWeight: "600" },
  mapArrow: { color: "#205D44", fontSize: 18 },
  buttonDisabled: { backgroundColor: "#F1F0EA" },
  pressed: { opacity: 0.72 },
  disabledText: { color: "#8D9088" },
  armedTag: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 5 },
  armedOn: { backgroundColor: "#DCEFE2" },
  armedOff: { backgroundColor: "#ECEAE2" },
  armedText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.6 },
  armedTextOn: { color: "#235E41" },
  armedTextOff: { color: "#646A60" },
  inputPanel: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#DCDDD3", borderRadius: 9, paddingHorizontal: 14 },
  inputRow: { flexDirection: "row", alignItems: "center", minHeight: 57 },
  inputMarker: { width: 9, height: 9, borderRadius: 5, marginRight: 11 },
  inputMarkerOn: { backgroundColor: "#CE6C38" },
  inputMarkerOff: { backgroundColor: "#8D9A91" },
  inputNameGroup: { flex: 1 },
  inputName: { color: "#25372F", fontSize: 13, fontWeight: "600" },
  inputPin: { color: "#68756E", fontSize: 10, marginTop: 3 },
  inputState: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  inputStateOn: { color: "#A94E27" },
  inputStateOff: { color: "#65746B" },
  rowDivider: { height: 1, backgroundColor: "#E7E7DF" },
  helperText: { color: "#5F6D66", fontSize: 11, lineHeight: 16, marginTop: 7, marginBottom: 23 },
  buzzerPanel: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#DCDDD3", borderRadius: 10, padding: 15 },
  buzzerStatusRow: { flexDirection: "row", alignItems: "center" },
  buzzerIndicator: { width: 11, height: 11, borderRadius: 6, marginRight: 10 },
  buzzerIndicatorOn: { backgroundColor: "#C85A34" },
  buzzerIndicatorOff: { backgroundColor: "#8D9A91" },
  buzzerCopy: { flex: 1 },
  buzzerTitle: { color: "#1D3029", fontSize: 14, fontWeight: "600" },
  controlRow: { flexDirection: "row", gap: 9, marginTop: 15 },
  secondaryButton: { flex: 1, minHeight: 43, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#C7CEC7", borderRadius: 6, backgroundColor: "#FFFFFF" },
  secondaryButtonText: { color: "#31443A", fontSize: 12, fontWeight: "600" },
  primaryButton: { flex: 1, minHeight: 43, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: "#236B55" },
  primaryDisabled: { backgroundColor: "#9AA89F" },
  primaryButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  errorText: { color: "#9A3F27", fontSize: 11, lineHeight: 16, marginTop: 10 },
  footerInfo: { marginTop: 23, paddingTop: 14, borderTopWidth: 1, borderTopColor: "#D7D9CF" },
  footerLine: { flexDirection: "row", alignItems: "flex-start", marginBottom: 9 },
  footerLabel: { width: 58, color: "#68766F", fontSize: 9, letterSpacing: 0.8, fontWeight: "700", paddingTop: 2 },
  footerValue: { flex: 1, color: "#46574E", fontSize: 11, lineHeight: 16 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  loadingText: { color: "#5F6D66", fontSize: 11 },
  disclaimer: { marginTop: 17, color: "#68766F", fontSize: 10, lineHeight: 15 },
});
