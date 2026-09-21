import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true, // exponer en la red local para probar desde el headset
  },
});
