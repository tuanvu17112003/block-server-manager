/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
      },
      colors: {
        mc: {
          stone: '#C6C6C6',
          slotmid: '#8B8B8B',
          graytext: '#555555',
          bevel: '#373737',
          well: '#212121',
          console: '#121212',
          grass: '#7CBD6B',
          leaves: '#48B518',
          chat: '#55FF55',
          darkgreen: '#00AA00',
          xp: '#80C71F',
          gold: '#FFAA00',
          splash: '#FFFF55',
          red: '#FF5555',
          darkred: '#AA0000',
          dirt: '#5D4037',
          dirt2: '#7C4B2A',
          dirtdark: '#2A1D12',
          stonegray: '#9E9E9E',
          sky: '#4FC3F7',
          creeper: '#0F800F',
          creeperlight: '#0DB50D',
        },
      },
    },
  },
  plugins: [],
};
