# Imagem base oficial do Node.js LTS leve
FROM node:22-alpine

# Define diretório de trabalho
WORKDIR /app

# Copia manifestos de dependências
COPY package*.json ./

# Instala dependências de produção
RUN npm ci --omit=dev --ignore-scripts

# Copia todo o código da aplicação
COPY . .

# Garante que os assets de vendor estejam atualizados
RUN node scripts/prepare-vendor.js

# Define variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=8900

# Expõe a porta 8900
EXPOSE 8900

# Inicia o servidor com a flag --no-open para ambientes headless/servidor
CMD ["node", "server.js", "--no-open"]
