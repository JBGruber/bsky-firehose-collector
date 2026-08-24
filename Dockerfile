FROM node:22-slim

WORKDIR /app

# Manifests first: a source change then reuses the cached install layer instead
# of reinstalling every dependency on every build.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV COLLECTOR_LISTENHOST=0.0.0.0

# Expose the port that the application listens on
EXPOSE 3000

# Command to run the application
CMD ["yarn", "start"]
