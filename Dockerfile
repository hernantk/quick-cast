# Imagem base oficial do Bun leve
FROM oven/bun:alpine

# Define diretório de trabalho
WORKDIR /app

# Copia manifestos de dependências
COPY package.json bun.lockb ./

# Instala dependências de produção
RUN bun install --frozen-lockfile --production

# Copia todo o código da aplicação
COPY . .

# Garante que os assets de vendor estejam atualizados
RUN bun scripts/prepare-vendor.js

# Define variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=8900

# Expõe a porta 8900
EXPOSE 8900

# Inicia o servidor com a flag --no-open para ambientes headless/servidor
CMD ["bun", "server.js", "--no-open"]
