#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include "segredos.h"

// ---------------- RC522 ----------------
#define SS_PIN  5
#define RST_PIN 22
MFRC522 rfid(SS_PIN, RST_PIN);

// ---------------- FECHADURA (relé) ----------------
#define PIN_RELE 26
const bool RELE_ATIVO_EM_LOW = true;          // a maioria dos módulos de relé liga com sinal LOW
const unsigned long TEMPO_ABERTO_MS = 5000;   // tempo que a fechadura fica recuada
bool releLigado = false;
unsigned long fechaEm = 0;

// ---------------- Tempos ----------------
const unsigned long HTTP_TIMEOUT_RFID_MS = 40000;  // Render pode demorar para acordar
const unsigned long HTTP_TIMEOUT_PING_MS = 10000;
const unsigned long INTERVALO_PING       = 20000;
const unsigned long ANTI_DUPLICACAO_MS   = 2000;
const int MAX_FALHAS_WIFI = 3;

String ultimoUID = "";
unsigned long ultimaLeitura = 0;
unsigned long ultimoPing = 0;
unsigned long ultimaTentativaWiFi = 0;
int falhasWiFi = 0;

// ===============================================================
// FECHADURA
// ===============================================================
void fechadura(bool abrir) {
  digitalWrite(PIN_RELE, (abrir == RELE_ATIVO_EM_LOW) ? LOW : HIGH);
}

void abrirFechadura() {
  fechadura(true);
  releLigado = true;
  fechaEm = millis() + TEMPO_ABERTO_MS;
  Serial.printf("FECHADURA ABERTA por %lu ms\n", TEMPO_ABERTO_MS);
}

void atualizarFechadura() {
  if (releLigado && (long)(millis() - fechaEm) >= 0) {
    fechadura(false);
    releLigado = false;
    Serial.println("Fechadura travada.");
  }
}

// ===============================================================
// UTILIDADES
// ===============================================================
String uidParaString() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// ===============================================================
// WI-FI: escolhe sozinho entre casa e eduroam
// ===============================================================
int procurarRede() {
  Serial.println("Procurando redes conhecidas...");
  int n = WiFi.scanNetworks();
  int achada = -1;

  for (int i = 0; i < NUM_REDES && achada < 0; i++) {
    for (int j = 0; j < n; j++) {
      if (WiFi.SSID(j) == REDES[i].ssid) {
        achada = i;
        break;
      }
    }
  }

  WiFi.scanDelete();
  return achada;
}

bool conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  int idx = procurarRede();
  if (idx < 0) {
    Serial.println("Nenhuma rede conhecida por perto.");
    return false;
  }

  const Rede& r = REDES[idx];
  Serial.printf("Conectando em '%s' (%s)\n", r.ssid,
                r.enterprise ? "WPA2-Enterprise" : "Wi-Fi comum");

  WiFi.disconnect(true);
  delay(500);

  if (r.enterprise) {
    WiFi.begin(r.ssid, WPA2_AUTH_PEAP, r.identidade, r.usuario, r.senha);
  } else {
    WiFi.begin(r.ssid, r.senha);
  }

  unsigned long inicio = millis();
  unsigned long limite = r.enterprise ? 60000 : 20000;

  while (WiFi.status() != WL_CONNECTED && millis() - inicio < limite) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Falha ao conectar. Confira usuario e senha.");
    return false;
  }

  Serial.printf("Conectado! IP: %s | sinal: %d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

// ===============================================================
// HTTP
// ===============================================================
int postJSON(const char* caminho, const String& corpo,
             unsigned long timeoutMs, String* resposta = nullptr) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = String(SERVER_URL) + caminho;

  if (!http.begin(client, url)) return -1;

  http.setTimeout(timeoutMs);
  http.addHeader("Content-Type", "application/json");

  int codigo = http.POST(corpo);

  if (codigo > 0) {
    String r = http.getString();
    if (resposta) *resposta = r;
  } else {
    Serial.printf("Erro HTTP: %s\n", http.errorToString(codigo).c_str());
  }

  http.end();
  return codigo;
}

bool testarServidor() {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, String(SERVER_URL) + "/health")) return false;

  http.setTimeout(HTTP_TIMEOUT_RFID_MS);
  int codigo = http.GET();
  Serial.printf("Servidor /health: %d\n", codigo);
  http.end();

  return codigo == 200;
}

void avisarOnline() {
  String corpo = String("{\"ip\":\"") + WiFi.localIP().toString() + "\"}";
  int codigo = postJSON("/api/esp32/online", corpo, HTTP_TIMEOUT_PING_MS);
  Serial.printf("Ping do servidor: %d\n", codigo);
  ultimoPing = millis();
}

void enviarRFID(const String& uid) {
  if (!conectarWiFi()) {
    Serial.println("Sem Wi-Fi. Tag nao enviada.");
    return;
  }

  String corpo = String("{\"uid\":\"") + uid +
                 "\",\"leitor\":\"entrada\",\"tipo\":\"rfid\"}";
  String resposta;
  int codigo = -1;

  for (int tentativa = 1; tentativa <= 2; tentativa++) {
    codigo = postJSON("/api/esp32/rfid", corpo, HTTP_TIMEOUT_RFID_MS, &resposta);
    if (codigo > 0) break;  // qualquer resposta do servidor conta como entregue

    Serial.println("Falhou. Tentando de novo em 2 s...");
    delay(2000);
    if (WiFi.status() != WL_CONNECTED) conectarWiFi();
  }

  if (codigo > 0) {
    Serial.printf("HTTP %d | %s\n", codigo, resposta.c_str());

    // O servidor autorizou a operação: libera a fechadura.
    if (resposta.indexOf("\"tipo\":\"retirada_concluida\"") >= 0 ||
        resposta.indexOf("\"tipo\":\"devolucao_concluida\"") >= 0 ||
        resposta.indexOf("\"abrir\":true") >= 0) {
      abrirFechadura();
    }
  } else {
    Serial.println("NAO FOI POSSIVEL ENVIAR A TAG.");
  }

  ultimoPing = millis();
}

// ===============================================================
// RC522
// ===============================================================
void inicializarRC522() {
  SPI.begin();
  rfid.PCD_Init();
  delay(100);
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);

  byte versao = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("Versao RC522: 0x%02X\n", versao);

  if (versao == 0x00 || versao == 0xFF) {
    Serial.println("ATENCAO: RC522 nao detectado. Confira a ligacao e os 3.3V.");
  } else {
    Serial.println("RC522 OK.");
  }
}

// ===============================================================
// SETUP / LOOP
// ===============================================================
void setup() {
  Serial.begin(115200);

  pinMode(PIN_RELE, OUTPUT);
  fechadura(false);  // sempre começa travada

  delay(1500);
  Serial.println("\n=== INVENTARIO RFID ===");

  inicializarRC522();

  if (conectarWiFi()) {
    testarServidor();
    avisarOnline();
  }

  Serial.println("Sistema pronto. Aproxime uma tag...");
  Serial.println("(Teste da fechadura: digite 'a' no Monitor Serial e envie)");
}

void loop() {
  atualizarFechadura();

  // Teste manual da fechadura pelo Monitor Serial
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'a' || c == 'A') abrirFechadura();
  }

  // Sem Wi-Fi: tenta de novo; depois de 3 falhas reinicia (limpa o estado da rede)
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - ultimaTentativaWiFi > 10000) {
      ultimaTentativaWiFi = millis();

      if (conectarWiFi()) {
        falhasWiFi = 0;
        testarServidor();
        avisarOnline();
      } else if (++falhasWiFi >= MAX_FALHAS_WIFI) {
        Serial.println("Reiniciando o ESP32...");
        delay(500);
        ESP.restart();
      }
    }
    delay(100);
    return;
  }

  // Mantém o servidor acordado e o status "ESP32 online" no site
  if (millis() - ultimoPing > INTERVALO_PING) avisarOnline();

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    delay(50);
    return;
  }

  String uid = uidParaString();

  if (uid == ultimoUID && millis() - ultimaLeitura < ANTI_DUPLICACAO_MS) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(100);
    return;
  }

  ultimoUID = uid;
  ultimaLeitura = millis();

  Serial.printf("\nTAG: %s (%d bytes)\n", uid.c_str(), rfid.uid.size);

  enviarRFID(uid);

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(150);
}