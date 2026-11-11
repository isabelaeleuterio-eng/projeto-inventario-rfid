
#define RELE_PIN 4

void setup() {
  digitalWrite(RELE_PIN, LOW);
  pinMode(RELE_PIN, OUTPUT);

  Serial.begin(115200);
  delay(300);

  Serial.println("TESTE DO RELE - GPIO 4");
  Serial.println("Fechadura deve estar desconectada!");
}

void loop() {
  Serial.println("GPIO 4 = LOW");
  digitalWrite(RELE_PIN, LOW);
  delay(2000);

  Serial.println("GPIO 4 = HIGH");
  digitalWrite(RELE_PIN, HIGH);
  delay(2000);
}
