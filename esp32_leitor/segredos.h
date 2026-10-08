#pragma once

struct Rede {
  const char* ssid;
  bool enterprise;         // false = Wi-Fi comum | true = eduroam (PEAP)
  const char* identidade;  // só para enterprise
  const char* usuario;     // só para enterprise
  const char* senha;
};

// Ordem = prioridade. Usa a primeira rede dessa lista que estiver no ar.
const Rede REDES[] = {
  { "Heloisa", false, "", "", "gustavo1952" },
  { "eduroam", true, "sp3217485", "sp3217485", "@Isabela06052003" },
};

const int NUM_REDES = sizeof(REDES) / sizeof(REDES[0]);

const char* SERVER_URL = "https://projeto-inventario-rfid.onrender.com";