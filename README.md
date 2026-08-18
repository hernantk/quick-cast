# 🚀 QuickCast — Compartilhamento de Tela Ultrarrápido & Leve

Um aplicativo moderno, leve e direto ao ponto para **compartilhar sua tela com áudio e webcam em altíssima qualidade (WebRTC P2P)**, sem que a outra pessoa precise instalar nada ou criar conta.

---

## ✨ Recursos Principais

- ⚡ **Zero Instalação para Visualizadores:** Basta enviar o link ou código de 6 dígitos. Funciona direto no navegador (Chrome, Edge, Firefox, Safari no PC ou celular).
- 🌐 **Integração Cloudflare Tunnel (1 Clique):** Gere um link público seguro HTTPS (`https://xyz.trycloudflare.com`) direto na interface ou com 1 comando, sem precisar abrir portas no roteador (com modal de confirmação de segurança para desativar).
- 🔒 **Proteção por Senha / PIN:** Crie salas públicas ou protegidas com senha para maior privacidade em reuniões e apresentações confidenciais.
- 👤 **Webcam do Apresentador (PiP Flutuante):** Transmita a sua webcam junto com a tela em uma janela flutuante arrastável (Picture-in-Picture) com botão de ligar/desligar ao vivo.
- 🚀 **Conexão WebRTC P2P:** Transmissão direta ponta-a-ponta entre você e os espectadores com latência ultrabaixa (< 150ms).
- 🎙️ **Mix de Áudio Inteligente:** Transmita o som do sistema/janela e, opcionalmente, seu microfone juntos na mesma transmissão.
- 📱 **QR Code Integrado:** Escaneie com a câmera do celular para assistir imediatamente.
- ⚙️ **Seletor de Qualidade:**
  - `1080p 60 FPS` — Fluidez máxima (Jogos / Vídeos / Apresentações dinâmicas)
  - `1080p 30 FPS` — Equilibrado
  - `720p 30 FPS` — Modo econômico para conexões mais lentas
  - `4K 30 FPS` — Altíssima resolução
- 📺 **Player Completo:** Tela cheia (`F`), Picture-in-Picture (`P`), Mute rápido (`M`), controle de volume e ajuste de proporção de tela.

---

## 🚀 Como Executar

### Opção 1: Executável Windows Standalone (`.exe` - Sem precisar de Node.js)
- Baixe o **`quickcast.exe`** direto na aba de [**Releases do GitHub**](https://github.com/hernantk/nao-fa-a-o-l/releases).
- Dê um duplo clique no arquivo `.exe`. O servidor iniciará e abrirá automaticamente seu navegador!

---

### Opção 2: Scripts Rápidos (.bat)
- Clique duplo em **`iniciar-com-internet.bat`** (Inicia com link de internet Cloudflare automático)
- Ou clique duplo em **`iniciar.bat`** (Para uso na mesma rede Wi-Fi / Local)

---

### Opção 2: Pelo Terminal

#### 🌐 Modo Online com Link de Internet (Recomendado)
```bash
npm run online
```
*(Gera automaticamente o link HTTPS da Cloudflare no terminal e conecta os espectadores de qualquer lugar do mundo)*

#### 🏠 Modo Local / Wi-Fi
```bash
npm start
```
*(Acesse `http://localhost:3000` ou pelo IP da rede exibido no terminal)*

---

### Opção 3: Ativar Cloudflare direto na Interface Web
Se você iniciou o app com `npm start`, basta clicar no botão **`🌐 Ativar Link de Internet (Cloudflare)`** no topo da página ou no card de criação da sala. O sistema gerará o link seguro em tempo real e atualizará os botões de copiar e QR Code automaticamente!

---

## 🛠️ Tecnologias Utilizadas
 
- **Backend:** Node.js, Express, Socket.IO, `untun` (Cloudflare Tunnel nativo).
- **Frontend:** Vanilla JavaScript moderno, WebRTC dual-stream (`RTCPeerConnection`, `getDisplayMedia`, `getUserMedia`, `AudioContext` mix), CSS3 com Glassmorphism.
- **STUN:** Servidores públicos do Google STUN para transposição de NAT ultrarrápida.

---

## 📦 Como Gerar o Executável (.exe)

Para compilar um novo executável autônomo:

```bash
npm run build:exe
```
O executável gerado estará na pasta `dist/quickcast.exe`.

### 🚀 Publicação Automática no GitHub Releases
Ao criar e enviar uma tag Git para o repositório, o GitHub Actions gera o executável automaticamente e anexa na Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

