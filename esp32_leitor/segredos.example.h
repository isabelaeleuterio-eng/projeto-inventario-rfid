#pragma once

// Copie este arquivo para segredos.h e preencha com suas credenciais locais.
// NÃO publique segredos.h no GitHub.

struct Rede {
  const char* ssid;
  bool enterprise;         // false = Wi-Fi comum | true = eduroam (PEAP)
  const char* identidade;  // somente para rede enterprise
  const char* usuario;     // somente para rede enterprise
  const char* senha;
};

const Rede REDES[] = {
  { "NOME_DA_REDE_WIFI", false, "", "", "SENHA_DO_WIFI" }
};

const int NUM_REDES = sizeof(REDES) / sizeof(REDES[0]);
const char* SERVER_URL = "https://SEU-SERVIDOR.onrender.com";
