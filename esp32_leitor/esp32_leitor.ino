/*
  ESP32 + RC522 + INVENTÁRIO RFID

  REDES:
  - Heloisa
  - eduroam (WPA2 Enterprise / PEAP)

  RC522:
  SDA/SS = GPIO 5
  RST    = GPIO 22

  TRAVA:
  GPIO 4

  SERVIDOR:
  Render

  FUNCIONAMENTO:
  1. ESP32 conecta no Wi-Fi.
  2. ESP32 avisa o servidor que está online.
  3. RC522 lê a tag.
  4. ESP32 envia o UID para o servidor.
  5. Servidor decide retirada/devolução.
  6. Servidor cria comando para a trava quando necessário.
  7. ESP32 consulta o comando.
  8. GPIO 4 libera a trava por 5 segundos.
  9. ESP32 confirma o comando ao servidor.

  IMPORTANTE:
  NÃO ligue trava/solenoide diretamente no GPIO 4.
  Use relé, MOSFET, transistor/driver e fonte adequada.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>

#include "segredos.h"


// ============================================================
// RC522
// ============================================================

#define SS_PIN 5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);


// ============================================================
// TRAVA
// ============================================================

#define TRAVA_PIN 4

/*
  true:
    LOW  = trava liberada
    HIGH = estado normal

  false:
    HIGH = trava liberada
    LOW  = estado normal
*/

const bool TRAVA_ATIVA_LOW = true;

const unsigned long TEMPO_TRAVA_PADRAO = 5000;

bool travaAtiva = false;

unsigned long travaDesligaEm = 0;


// ============================================================
// SERVIDOR
// ============================================================

const unsigned long HTTP_TIMEOUT_RFID = 40000;

const unsigned long HTTP_TIMEOUT_COMANDO = 10000;


// ============================================================
// CONTROLE RFID
// ============================================================

String ultimoUID = "";

unsigned long ultimaLeitura = 0;

const unsigned long TEMPO_ANTI_DUPLICACAO = 2000;


// ============================================================
// PING DO SERVIDOR
// ============================================================

unsigned long ultimoPing = 0;

const unsigned long INTERVALO_PING =
  10UL * 60UL * 1000UL;


// ============================================================
// CONTROLE DAS REDES
// ============================================================

int redeAtual = -1;


// ============================================================
// CONTROLE DOS COMANDOS DA TRAVA
// ============================================================

unsigned long ultimaConsultaComando = 0;

const unsigned long INTERVALO_COMANDO = 700;

long ultimoComandoExecutado = 0;

long ultimoComandoConfirmado = 0;

unsigned long ultimaTentativaConfirmacao = 0;

const unsigned long INTERVALO_RECONFIRMACAO = 2000;


// ============================================================
// TRAVA - ESTADO NORMAL
// ============================================================

void travaNormal() {

  if (TRAVA_ATIVA_LOW) {

    digitalWrite(
      TRAVA_PIN,
      HIGH
    );

  } else {

    digitalWrite(
      TRAVA_PIN,
      LOW
    );

  }

  travaAtiva = false;

  travaDesligaEm = 0;
}


// ============================================================
// TRAVA - LIBERAR
// ============================================================

void liberarTrava(unsigned long tempoMs) {

  if (tempoMs == 0) {

    tempoMs =
      TEMPO_TRAVA_PADRAO;
  }


  if (TRAVA_ATIVA_LOW) {

    digitalWrite(
      TRAVA_PIN,
      LOW
    );

  } else {

    digitalWrite(
      TRAVA_PIN,
      HIGH
    );

  }


  travaAtiva = true;

  travaDesligaEm =
    millis() + tempoMs;


  Serial.println();

  Serial.println(
    "=============================="
  );

  Serial.println(
    "TRAVA LIBERADA"
  );

  Serial.print(
    "GPIO: "
  );

  Serial.println(
    TRAVA_PIN
  );

  Serial.print(
    "Tempo: "
  );

  Serial.print(
    tempoMs
  );

  Serial.println(
    " ms"
  );

  Serial.println(
    "=============================="
  );
}


// ============================================================
// ATUALIZAR TRAVA
// ============================================================

void atualizarTrava() {

  if (!travaAtiva) {

    return;
  }


  if (
    (long)(
      millis() -
      travaDesligaEm
    ) >= 0
  ) {

    travaNormal();

    Serial.println(
      "Trava voltou ao estado normal."
    );
  }
}


// ============================================================
// CONVERTER UID
// ============================================================

String uidParaString() {

  String uid = "";


  for (
    byte i = 0;
    i < rfid.uid.size;
    i++
  ) {

    if (
      rfid.uid.uidByte[i] < 0x10
    ) {

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
// CONECTAR A UMA REDE
// ============================================================

bool conectarRede(const Rede& rede, int indice) {

  Serial.println();

  Serial.println(
    "===================================="
  );

  Serial.print(
    "TENTANDO REDE: "
  );

  Serial.println(
    rede.ssid
  );

  Serial.println(
    "===================================="
  );


  WiFi.disconnect(true);

  delay(500);

  WiFi.mode(WIFI_STA);

  WiFi.setSleep(false);


  // ----------------------------------------------------------
  // WI-FI COMUM
  // ----------------------------------------------------------

  if (!rede.enterprise) {

    Serial.println(
      "Tipo: Wi-Fi comum"
    );

    WiFi.begin(
      rede.ssid,
      rede.senha
    );

  }

  // ----------------------------------------------------------
  // EDUROAM / WPA2 ENTERPRISE
  // ----------------------------------------------------------

  else {

    Serial.println(
      "Tipo: WPA2 Enterprise / PEAP"
    );

    Serial.print(
      "Identidade: "
    );

    Serial.println(
      rede.identidade
    );

    Serial.print(
      "Usuario: "
    );

    Serial.println(
      rede.usuario
    );


    /*
      WPA2 Enterprise / PEAP

      Ordem:
      SSID
      método
      identidade
      usuário
      senha
    */

    WiFi.begin(
      rede.ssid,
      WPA2_AUTH_PEAP,
      rede.identidade,
      rede.usuario,
      rede.senha
    );
  }


  unsigned long inicio =
    millis();


  while (
    WiFi.status() != WL_CONNECTED
    &&
    millis() - inicio < 20000
  ) {

    delay(500);

    Serial.print(".");
  }


  Serial.println();


  if (
    WiFi.status() != WL_CONNECTED
  ) {

    Serial.println(
      "Falha ao conectar nesta rede."
    );

    return false;
  }


  redeAtual = indice;


  Serial.println();

  Serial.println(
    "************************************"
  );

  Serial.println(
    "WI-FI CONECTADO!"
  );

  Serial.print(
    "Rede: "
  );

  Serial.println(
    rede.ssid
  );

  Serial.print(
    "IP: "
  );

  Serial.println(
    WiFi.localIP()
  );

  Serial.print(
    "RSSI: "
  );

  Serial.println(
    WiFi.RSSI()
  );

  Serial.println(
    "************************************"
  );


  return true;
}


// ============================================================
// CONECTAR WI-FI
// ============================================================

bool conectarWiFi() {

  if (
    WiFi.status() == WL_CONNECTED
  ) {

    return true;
  }


  Serial.println();

  Serial.println(
    "===================================="
  );

  Serial.println(
    "PROCURANDO REDES CONFIGURADAS"
  );

  Serial.println(
    "===================================="
  );


  /*
    Primeiro fazemos uma varredura.

    Isso evita ficar esperando 20 segundos
    por uma rede que nem está disponível.
  */

  int quantidadeRedes =
    WiFi.scanNetworks(
      false,
      true
    );


  Serial.print(
    "Redes encontradas: "
  );

  Serial.println(
    quantidadeRedes
  );


  // ----------------------------------------------------------
  // TENTAR REDES NA ORDEM DO secrets.h
  // ----------------------------------------------------------

  for (
    int i = 0;
    i < NUM_REDES;
    i++
  ) {

    bool encontrada = false;


    for (
      int j = 0;
      j < quantidadeRedes;
      j++
    ) {

      if (
        WiFi.SSID(j) ==
        String(REDES[i].ssid)
      ) {

        encontrada = true;

        Serial.print(
          "Rede encontrada: "
        );

        Serial.println(
          REDES[i].ssid
        );

        break;
      }
    }


    if (!encontrada) {

      Serial.print(
        "Rede não encontrada: "
      );

      Serial.println(
        REDES[i].ssid
      );

      continue;
    }


    if (
      conectarRede(
        REDES[i],
        i
      )
    ) {

      WiFi.scanDelete();

      return true;
    }
  }


  WiFi.scanDelete();


  // ----------------------------------------------------------
  // SEGUNDA TENTATIVA
  // ----------------------------------------------------------

  Serial.println();

  Serial.println(
    "Nenhuma conexão foi estabelecida."
  );

  Serial.println(
    "Tentando as redes diretamente..."
  );


  for (
    int i = 0;
    i < NUM_REDES;
    i++
  ) {

    if (
      conectarRede(
        REDES[i],
        i
      )
    ) {

      return true;
    }
  }


  Serial.println();

  Serial.println(
    "ERRO: Wi-Fi não conectado."
  );

  return false;
}


// ============================================================
// AVISAR SERVIDOR ONLINE
// ============================================================

bool avisarOnline() {

  if (!conectarWiFi()) {

    return false;
  }


  WiFiClientSecure client;

  client.setInsecure();


  HTTPClient http;


  String url =
    String(SERVER_URL) +
    "/api/esp32/online";


  if (
    !http.begin(
      client,
      url
    )
  ) {

    Serial.println(
      "Erro ao iniciar HTTPS online."
    );

    return false;
  }


  http.setTimeout(
    HTTP_TIMEOUT_RFID
  );


  http.addHeader(
    "Content-Type",
    "application/json"
  );


  String body =
    String("{\"ip\":\"") +
    WiFi.localIP().toString() +
    "\"}";


  int codigo =
    http.POST(body);


  Serial.print(
    "Online HTTP: "
  );

  Serial.println(
    codigo
  );


  http.end();


  if (codigo > 0) {

    ultimoPing =
      millis();

    return true;
  }


  return false;
}


// ============================================================
// ENVIAR RFID
// ============================================================

bool tentarEnviarRFID(
  const String& uid
) {

  if (!conectarWiFi()) {

    return false;
  }


  WiFiClientSecure client;

  client.setInsecure();


  HTTPClient http;


  String url =
    String(SERVER_URL) +
    "/api/esp32/rfid";


  if (
    !http.begin(
      client,
      url
    )
  ) {

    Serial.println(
      "ERRO ao iniciar HTTPS RFID."
    );

    return false;
  }


  http.setTimeout(
    HTTP_TIMEOUT_RFID
  );


  http.addHeader(
    "Content-Type",
    "application/json"
  );


  String body =
    String("{\"uid\":\"") +
    uid +
    "\",\"leitor\":\"entrada\"}";


  Serial.println();

  Serial.println(
    "ENVIANDO RFID:"
  );

  Serial.println(
    body
  );


  int codigo =
    http.POST(body);


  Serial.print(
    "HTTP RFID: "
  );

  Serial.println(
    codigo
  );


  if (codigo > 0) {

    String resposta =
      http.getString();


    Serial.println(
      "Resposta:"
    );

    Serial.println(
      resposta
    );


    http.end();

    return true;
  }


  Serial.print(
    "Erro HTTP: "
  );

  Serial.println(
    http.errorToString(
      codigo
    )
  );


  http.end();

  return false;
}


// ============================================================
// ENVIAR RFID COM RETENTATIVA
// ============================================================

void enviarRFID(
  const String& uid
) {

  if (!conectarWiFi()) {

    Serial.println(
      "Sem Wi-Fi. RFID não enviado."
    );

    return;
  }


  bool sucesso =
    tentarEnviarRFID(uid);


  if (!sucesso) {

    Serial.println(
      "Tentando novamente em 2 segundos..."
    );


    delay(2000);


    sucesso =
      tentarEnviarRFID(uid);
  }


  if (!sucesso) {

    Serial.println(
      "Falha definitiva no envio RFID."
    );
  }
}


// ============================================================
// EXTRAIR STRING DO JSON
// ============================================================

String extrairStringJSON(
  const String& json,
  const String& chave
) {

  String procura =
    String("\"") +
    chave +
    "\"";


  int inicio =
    json.indexOf(procura);


  if (inicio < 0) {

    return "";
  }


  inicio =
    json.indexOf(
      ':',
      inicio
    );


  if (inicio < 0) {

    return "";
  }


  inicio++;


  while (
    inicio < (int)json.length()
    &&
    (
      json[inicio] == ' '
      ||
      json[inicio] == '"'
    )
  ) {

    inicio++;
  }


  int fim =
    json.indexOf(
      '"',
      inicio
    );


  if (fim < 0) {

    return "";
  }


  return json.substring(
    inicio,
    fim
  );
}


// ============================================================
// EXTRAIR NÚMERO DO JSON
// ============================================================

long extrairLongJSON(
  const String& json,
  const String& chave
) {

  String procura =
    String("\"") +
    chave +
    "\"";


  int inicio =
    json.indexOf(procura);


  if (inicio < 0) {

    return 0;
  }


  inicio =
    json.indexOf(
      ':',
      inicio
    );


  if (inicio < 0) {

    return 0;
  }


  inicio++;


  while (
    inicio < (int)json.length()
    &&
    (
      json[inicio] == ' '
      ||
      json[inicio] == '"'
    )
  ) {

    inicio++;
  }


  int fim = inicio;


  while (
    fim < (int)json.length()
    &&
    json[fim] >= '0'
    &&
    json[fim] <= '9'
  ) {

    fim++;
  }


  if (fim == inicio) {

    return 0;
  }


  return json.substring(
    inicio,
    fim
  ).toInt();
}


// ============================================================
// CONFIRMAR COMANDO
// ============================================================

bool confirmarComando(
  long id
) {

  if (!conectarWiFi()) {

    return false;
  }


  WiFiClientSecure client;

  client.setInsecure();


  HTTPClient http;


  String url =
    String(SERVER_URL) +
    "/api/esp32/comando/confirmar";


  if (
    !http.begin(
      client,
      url
    )
  ) {

    return false;
  }


  http.setTimeout(
    HTTP_TIMEOUT_COMANDO
  );


  http.addHeader(
    "Content-Type",
    "application/json"
  );


  String body =
    String("{\"id\":") +
    String(id) +
    "}";


  int codigo =
    http.POST(body);


  if (codigo > 0) {

    Serial.print(
      "Comando "
    );

    Serial.print(
      id
    );

    Serial.println(
      " confirmado no servidor."
    );


    http.end();

    return true;
  }


  Serial.println(
    "Não foi possível confirmar o comando."
  );


  http.end();

  return false;
}


// ============================================================
// CONSULTAR COMANDO DA TRAVA
// ============================================================

void consultarComando() {

  if (
    WiFi.status() != WL_CONNECTED
  ) {

    return;
  }


  WiFiClientSecure client;

  client.setInsecure();


  HTTPClient http;


  String url =
    String(SERVER_URL) +
    "/api/esp32/comando";


  if (
    !http.begin(
      client,
      url
    )
  ) {

    return;
  }


  http.setTimeout(
    HTTP_TIMEOUT_COMANDO
  );


  int codigo =
    http.GET();


  if (codigo <= 0) {

    http.end();

    return;
  }


  String resposta =
    http.getString();


  http.end();


  long id =
    extrairLongJSON(
      resposta,
      "id"
    );


  String tipo =
    extrairStringJSON(
      resposta,
      "tipo"
    );


  long tempo =
    extrairLongJSON(
      resposta,
      "tempo_liberacao_ms"
    );


  if (id <= 0) {

    return;
  }


  if (
    tipo != "liberar_caixa"
  ) {

    return;
  }


  // ==========================================================
  // NOVO COMANDO
  // ==========================================================

  if (
    id != ultimoComandoExecutado
  ) {

    ultimoComandoExecutado =
      id;


    Serial.println();

    Serial.println(
      "=============================="
    );

    Serial.println(
      "NOVO COMANDO DA TRAVA"
    );

    Serial.print(
      "ID: "
    );

    Serial.println(
      id
    );

    Serial.print(
      "Tempo: "
    );

    Serial.println(
      tempo
    );

    Serial.println(
      "=============================="
    );


    if (tempo <= 0) {

      tempo =
        TEMPO_TRAVA_PADRAO;
    }


    liberarTrava(
      (unsigned long)tempo
    );


    if (
      confirmarComando(id)
    ) {

      ultimoComandoConfirmado =
        id;
    }


    ultimaTentativaConfirmacao =
      millis();
  }


  // ==========================================================
  // SE EXECUTOU MAS NÃO CONFIRMOU
  // ==========================================================

  else if (
    id != ultimoComandoConfirmado
    &&
    millis() -
    ultimaTentativaConfirmacao
    >=
    INTERVALO_RECONFIRMACAO
  ) {

    if (
      confirmarComando(id)
    ) {

      ultimoComandoConfirmado =
        id;
    }


    ultimaTentativaConfirmacao =
      millis();
  }
}


// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  delay(1000);


  Serial.println();

  Serial.println(
    "===================================="
  );

  Serial.println(
    " INVENTÁRIO RFID"
  );

  Serial.println(
    " ESP32 + RC522 + TRAVA"
  );

  Serial.println(
    " TRAVA = GPIO 4"
  );

  Serial.println(
    " ABERTURA = 5 SEGUNDOS"
  );

  Serial.println(
    "===================================="
  );


  // ==========================================================
  // TRAVA
  // ==========================================================

  pinMode(
    TRAVA_PIN,
    OUTPUT
  );


  travaNormal();


  Serial.println(
    "GPIO 4 configurado."
  );


  // ==========================================================
  // SPI
  // ==========================================================

  SPI.begin();


  // ==========================================================
  // RC522
  // ==========================================================

  rfid.PCD_Init();

  delay(100);


  rfid.PCD_SetAntennaGain(
    MFRC522::RxGain_max
  );


  byte versao =
    rfid.PCD_ReadRegister(
      MFRC522::VersionReg
    );


  Serial.print(
    "Versão RC522: 0x"
  );

  Serial.println(
    versao,
    HEX
  );


  if (
    versao == 0x00
    ||
    versao == 0xFF
  ) {

    Serial.println(
      "ATENÇÃO: RC522 não detectado corretamente."
    );

  } else {

    Serial.println(
      "RC522 detectado corretamente."
    );
  }


  // ==========================================================
  // WI-FI
  // ==========================================================

  conectarWiFi();


  delay(500);


  // ==========================================================
  // SERVIDOR
  // ==========================================================

  if (
    WiFi.status() == WL_CONNECTED
  ) {

    avisarOnline();
  }


  Serial.println();

  Serial.println(
    "SISTEMA PRONTO."
  );

  Serial.println(
    "Aproxime uma tag..."
  );
}


// ============================================================
// LOOP
// ============================================================

void loop() {

  // ----------------------------------------------------------
  // ATUALIZAR TRAVA
  // ----------------------------------------------------------

  atualizarTrava();


  // ----------------------------------------------------------
  // WI-FI
  // ----------------------------------------------------------

  if (
    WiFi.status() != WL_CONNECTED
  ) {

    Serial.println();

    Serial.println(
      "Wi-Fi desconectado."
    );

    if (
      conectarWiFi()
    ) {

      avisarOnline();
    }


    delay(500);
  }


  // ----------------------------------------------------------
  // PING
  // ----------------------------------------------------------

  if (
    WiFi.status() == WL_CONNECTED
    &&
    millis() -
    ultimoPing
    >
    INTERVALO_PING
  ) {

    avisarOnline();
  }


  // ----------------------------------------------------------
  // CONSULTAR COMANDO DA TRAVA
  // ----------------------------------------------------------

  if (
    WiFi.status() == WL_CONNECTED
    &&
    millis() -
    ultimaConsultaComando
    >=
    INTERVALO_COMANDO
  ) {

    ultimaConsultaComando =
      millis();


    consultarComando();
  }


  // ----------------------------------------------------------
  // RFID
  // ----------------------------------------------------------

  if (
    !rfid.PICC_IsNewCardPresent()
  ) {

    delay(30);

    return;
  }


  if (
    !rfid.PICC_ReadCardSerial()
  ) {

    delay(30);

    return;
  }


  String uid =
    uidParaString();


  // ----------------------------------------------------------
  // EVITAR DUPLICAÇÃO
  // ----------------------------------------------------------

  if (
    uid == ultimoUID
    &&
    millis() -
    ultimaLeitura
    <
    TEMPO_ANTI_DUPLICACAO
  ) {

    rfid.PICC_HaltA();

    rfid.PCD_StopCrypto1();

    delay(100);

    return;
  }


  ultimoUID =
    uid;

  ultimaLeitura =
    millis();


  // ----------------------------------------------------------
  // MOSTRAR TAG
  // ----------------------------------------------------------

  Serial.println();

  Serial.println(
    "=============================="
  );

  Serial.println(
    "TAG DETECTADA"
  );

  Serial.print(
    "UID: "
  );

  Serial.println(
    uid
  );

  Serial.print(
    "Tamanho: "
  );

  Serial.print(
    rfid.uid.size
  );

  Serial.println(
    " bytes"
  );

  Serial.println(
    "=============================="
  );


  // ----------------------------------------------------------
  // ENVIAR AO SERVIDOR
  // ----------------------------------------------------------

  enviarRFID(uid);


  // ----------------------------------------------------------
  // ENCERRAR LEITURA RC522
  // ----------------------------------------------------------

  rfid.PICC_HaltA();

  rfid.PCD_StopCrypto1();


  delay(150);
}