/*
  ESP32 + RC522 + INVENTÁRIO RFID
  VERSÃO NUVEM - CORRIGIDA

  ESP32 envia diretamente para o Render:
  https://projeto-inventario-rfid.onrender.com

  Leitor:
  entrada

  Fluxo:
  1. ESP32 conecta no Wi-Fi
  2. Avisa o servidor que está online
  3. Lê a tag RFID
  4. Envia o UID para a API
  5. O servidor identifica funcionário/equipamento

  -----------------------------------------------------------
  CORREÇÕES NESTA VERSÃO
  -----------------------------------------------------------
  1) TIMEOUT AUMENTADO (15s -> 40s).
     O Render gratuito "hiberna" o servidor depois de um
     tempo sem uso. Quando isso acontece, a PRIMEIRA
     requisição depois de dormir pode levar 20-50s para
     responder. Com 15s de timeout, essa leitura sempre
     falhava silenciosamente (parecia que "nada acontecia").

  2) RETENTATIVA AUTOMÁTICA.
     Se o envio falhar (timeout, Wi-Fi instável, etc.), o
     ESP32 tenta mais uma vez automaticamente antes de
     desistir da leitura.

  3) PING DE "MANTER ACORDADO" A CADA 10 MINUTOS.
     O ESP32 agora acorda o servidor periodicamente (mesmo
     sem ninguém passar tag), então na prática o Render quase
     nunca chega a dormir e a leitura funciona na hora.

  4) WiFi.setSleep(false).
     Desliga o modo de economia de energia do Wi-Fi do ESP32,
     que causa lentidão e quedas de conexão intermitentes.

  5) Reconecta e reavisa o servidor automaticamente se o
     Wi-Fi cair e voltar.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>

// ============================================================
// RC522
// ============================================================

#define SS_PIN  5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);

// ============================================================
// WI-FI
// ============================================================

const char* WIFI_SSID = "Família Eleuterio-2G";
const char* WIFI_PASSWORD = "Carlao01091910";

// ============================================================
// SERVIDOR NA NUVEM
// ============================================================

const char* SERVER_URL =
  "https://projeto-inventario-rfid.onrender.com";

// Tempo máximo de espera por resposta do servidor.
// Precisa ser alto por causa da hibernação do Render free.
const unsigned long HTTP_TIMEOUT_MS = 40000;

// ============================================================
// CONTROLE DE LEITURA
// ============================================================

String ultimoUID = "";
unsigned long ultimaLeitura = 0;
const unsigned long TEMPO_ANTI_DUPLICACAO = 2000;

// ============================================================
// CONTROLE DE "MANTER SERVIDOR ACORDADO"
// ============================================================

unsigned long ultimoPing = 0;
const unsigned long INTERVALO_PING = 10UL * 60UL * 1000UL; // 10 minutos

// ============================================================
// CONVERTER UID
// ============================================================

String uidParaString() {

  String uid = "";

  for (byte i = 0; i < rfid.uid.size; i++) {

    if (rfid.uid.uidByte[i] < 0x10) {
      uid += "0";
    }

    uid += String(
      rfid.uid.uidByte[i],
      HEX
    );
  }

  uid.toUpperCase();

  return uid;
}

// ============================================================
// CONECTAR WI-FI
// ============================================================

bool conectarWiFi() {

  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  Serial.println();
  Serial.println("==============================");
  Serial.println("CONECTANDO AO WI-FI");
  Serial.println("==============================");

  Serial.print("Rede: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);

  // Desliga o modo de economia de energia do rádio Wi-Fi.
  // Sem isso o ESP32 pode ficar lento/instável em conexões
  // HTTP contínuas.
  WiFi.setSleep(false);

  WiFi.disconnect(true);
  delay(500);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  unsigned long inicio = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - inicio < 20000
  ) {

    delay(500);

    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {

    Serial.println();
    Serial.println("ERRO: WIFI NAO CONECTADO");

    return false;
  }

  Serial.println();
  Serial.println("WIFI CONECTADO!");

  Serial.print("IP do ESP32: ");
  Serial.println(WiFi.localIP());

  Serial.print("RSSI: ");
  Serial.println(WiFi.RSSI());

  return true;
}

// ============================================================
// AVISAR SERVIDOR QUE ESP32 ESTÁ ONLINE
// (também funciona como "acordar" o Render)
// ============================================================

bool avisarOnline() {

  if (!conectarWiFi()) {
    return false;
  }

  Serial.println();
  Serial.println("==============================");
  Serial.println("AVISANDO SERVIDOR");
  Serial.println("==============================");

  String url =
    String(SERVER_URL) +
    "/api/esp32/online";

  Serial.print("URL: ");
  Serial.println(url);

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  if (!http.begin(client, url)) {
    Serial.println("ERRO: nao foi possivel iniciar HTTPS.");
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  String body =
    String("{\"ip\":\"") +
    WiFi.localIP().toString() +
    "\"}";

  Serial.print("Enviando: ");
  Serial.println(body);

  int codigo = http.POST(body);

  Serial.print("HTTP: ");
  Serial.println(codigo);

  if (codigo <= 0) {
    Serial.print("Erro HTTP detalhado: ");
    Serial.println(http.errorToString(codigo));
  }

  bool sucesso = false;

  if (codigo > 0) {

    String resposta =
      http.getString();

    Serial.println("Resposta do servidor:");

    Serial.println(resposta);

    sucesso = true;

  } else {

    Serial.print("Erro ao avisar servidor: ");
    Serial.println(
      http.errorToString(codigo)
    );
  }

  http.end();

  ultimoPing = millis();

  return sucesso;
}

// ============================================================
// ENVIAR RFID PARA O SERVIDOR (com retentativa)
// ============================================================

bool tentarEnviarRFID(String uid) {

  String url =
    String(SERVER_URL) +
    "/api/esp32/rfid";

  Serial.print("URL: ");
  Serial.println(url);

  HTTPClient http;

  http.begin(url);

  // Timeout alto: o Render pode demorar bastante para
  // responder quando estava hibernando.
  http.setTimeout(HTTP_TIMEOUT_MS);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  String body =
    String("{\"uid\":\"") +
    uid +
    "\",\"leitor\":\"entrada\",\"tipo\":\"rfid\"}";

  Serial.print("JSON enviado: ");
  Serial.println(body);

  int codigo =
    http.POST(body);

  Serial.print("Codigo HTTP: ");
  Serial.println(codigo);

  if (codigo <= 0) {
    Serial.print("Erro HTTP detalhado: ");
    Serial.println(http.errorToString(codigo));
  }

  bool sucesso = false;

  if (codigo > 0) {

    String resposta =
      http.getString();

    Serial.println();
    Serial.println("RESPOSTA DO SERVIDOR:");
    Serial.println("------------------------------");

    Serial.println(resposta);

    Serial.println("------------------------------");

    sucesso = true;

  } else {

    Serial.println();
    Serial.println("ERRO AO ENVIAR:");

    Serial.println(
      http.errorToString(codigo)
    );
  }

  http.end();

  return sucesso;
}

void enviarRFID(String uid) {

  if (!conectarWiFi()) {

    Serial.println(
      "Sem Wi-Fi. RFID nao enviado."
    );

    return;
  }

  Serial.println();
  Serial.println("==============================");
  Serial.println("ENVIANDO RFID AO SERVIDOR");
  Serial.println("==============================");

  Serial.print("UID: ");
  Serial.println(uid);

  bool ok = tentarEnviarRFID(uid);

  if (!ok) {

    Serial.println();
    Serial.println(
      "Primeira tentativa falhou. Tentando novamente em 2s..."
    );

    delay(2000);

    ok = tentarEnviarRFID(uid);
  }

  if (!ok) {
    Serial.println(
      "Nao foi possivel enviar a leitura mesmo apos retentativa."
    );
  }

  ultimoPing = millis();
}

// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("==============================");
  Serial.println(" INVENTARIO RFID");
  Serial.println(" ESP32 + RC522 + NUVEM");
  Serial.println("==============================");

  // ----------------------------------------------------------
  // SPI
  // ----------------------------------------------------------

  Serial.println();
  Serial.println("Inicializando SPI...");

  SPI.begin();

  // ----------------------------------------------------------
  // RC522
  // ----------------------------------------------------------

  Serial.println("Inicializando RC522...");

  rfid.PCD_Init();

  delay(100);

  // Ganho máximo para facilitar a leitura das tags, inclusive UIDs de 7 bytes.
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);

  byte versao =
    rfid.PCD_ReadRegister(
      MFRC522::VersionReg
    );

  Serial.print("Versao RC522: 0x");

  Serial.println(
    versao,
    HEX
  );

  if (
    versao == 0x00 ||
    versao == 0xFF
  ) {

    Serial.println();
    Serial.println(
      "ATENCAO: RC522 nao detectado corretamente."
    );

  } else {

    Serial.println(
      "RC522 detectado corretamente."
    );
  }

  // ----------------------------------------------------------
  // WI-FI
  // ----------------------------------------------------------

  conectarWiFi();

  delay(1000);

  // ----------------------------------------------------------
  // SERVIDOR (isso já "acorda" o Render se estiver dormindo)
  // ----------------------------------------------------------

  avisarOnline();

  // ----------------------------------------------------------
  // PRONTO
  // ----------------------------------------------------------

  Serial.println();
  Serial.println("==============================");
  Serial.println("SISTEMA PRONTO");
  Serial.println("==============================");

  Serial.println(
    "Aproxime uma tag..."
  );

  Serial.println();
}

// ============================================================
// LOOP
// ============================================================

void loop() {

  // ----------------------------------------------------------
  // VERIFICAR WI-FI
  // ----------------------------------------------------------

  if (
    WiFi.status() != WL_CONNECTED
  ) {

    Serial.println();
    Serial.println(
      "Wi-Fi desconectado. Reconectando..."
    );

    if (conectarWiFi()) {
      // Reconectou depois de cair: reavisa o servidor.
      avisarOnline();
    }

    delay(1000);
  }

  // ----------------------------------------------------------
  // MANTER O RENDER ACORDADO (ping periódico)
  // ----------------------------------------------------------

  if (millis() - ultimoPing > INTERVALO_PING) {
    avisarOnline();
  }

  // ----------------------------------------------------------
  // VERIFICAR NOVA TAG
  // ----------------------------------------------------------

  if (
    !rfid.PICC_IsNewCardPresent()
  ) {

    delay(50);

    return;
  }

  // ----------------------------------------------------------
  // LER TAG
  // ----------------------------------------------------------

  if (
    !rfid.PICC_ReadCardSerial()
  ) {

    delay(50);

    return;
  }

  // ----------------------------------------------------------
  // PEGAR UID
  // ----------------------------------------------------------

  String uid =
    uidParaString();

  // ----------------------------------------------------------
  // IGNORAR TAG REPETIDA
  // ----------------------------------------------------------

  if (
    uid == ultimoUID &&
    millis() - ultimaLeitura <
      TEMPO_ANTI_DUPLICACAO
  ) {

    rfid.PICC_HaltA();

    rfid.PCD_StopCrypto1();

    delay(100);

    return;
  }

  // ----------------------------------------------------------
  // REGISTRAR LEITURA
  // ----------------------------------------------------------

  ultimoUID =
    uid;

  ultimaLeitura =
    millis();

  // ----------------------------------------------------------
  // MOSTRAR TAG
  // ----------------------------------------------------------

  Serial.println();

  Serial.println("==============================");
  Serial.println("TAG DETECTADA");
  Serial.println("==============================");

  Serial.print("UID: ");
  Serial.println(uid);

  Serial.print("Tamanho UID: ");
  Serial.print(rfid.uid.size);
  Serial.println(" bytes");

  if (rfid.uid.size == 7) {
    Serial.println("Tipo: UID de 7 bytes (tag de equipamento).");
  } else if (rfid.uid.size == 4) {
    Serial.println("Tipo: UID de 4 bytes (tag/cartao de funcionario).");
  } else {
    Serial.println("Tipo: UID de tamanho diferente.");
  }

  // ----------------------------------------------------------
  // ENVIAR PARA NUVEM
  // ----------------------------------------------------------

  enviarRFID(uid);

  // ----------------------------------------------------------
  // FINALIZAR COMUNICACAO RFID
  // ----------------------------------------------------------

  rfid.PICC_HaltA();

  rfid.PCD_StopCrypto1();

  Serial.println();
  Serial.println(
    "Aproxime outra tag..."
  );

  Serial.println();

  delay(150);
}
