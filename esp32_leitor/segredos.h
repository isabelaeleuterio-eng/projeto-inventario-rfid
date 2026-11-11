#pragma once

struct Rede {
  const char* ssid;
  bool enterprise;         // false = Wi-Fi comum | true = eduroam (PEAP)
  const char* identidade;  // só para enterprise
  const char* usuario;     // só para enterprise
  const char* senha;
};

const Rede REDES[] = {
  { "...", false, "", "", "..." }
};
//Ordem = prioridade. Usa a primeira rede dessa lista que estiver no ar.
//const Rede REDES[] = {
  //{ "Isabela", false, "", "", "123456789" },
  //{ "Isa_Eleutéro", false, "", "", "123456789" },
  //{ "Heloisa", false, "", "", "gustavo1952" },
  //{ "Família Eleuterio-2G", false, "", "", "Carlao01091910" },
  //{ "eduroam", true, "sp3217485", "sp3217485", "@Isabela06052003" },
//};

const int NUM_REDES = sizeof(REDES) / sizeof(REDES[0]);

const char* SERVER_URL = "https://projeto-inventario-rfid.onrender.com";
