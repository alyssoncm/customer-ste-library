# Use the latest Node.js version as base image
FROM node:latest as build-step

# Set working directory
WORKDIR /app

# Copy package.json
COPY ./app/package.json /app

# Install Angular CLI globally in the image
RUN npm install -g @angular/cli@latest

# Install all dependencies, using --legacy-peer-deps to avoid issues with peer dependencies
RUN npm install --legacy-peer-deps

# Copy the rest of the application code
COPY ./app/ /app

# Use the Angular CLI to build the application with the production configuration
RUN ng build --configuration production

# Start a new stage from the latest nginx image
FROM nginx:latest

# Copy the built app from the previous stage to the nginx html directory
COPY --from=build-step /app/dist /usr/share/nginx/html
