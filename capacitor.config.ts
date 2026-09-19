import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kr.lupa.golfscore',
  appName: 'Golf Score AI',
  webDir: 'dist',
  server: {
    // 앱에서 API 호출 시 사용할 서버 주소
    // 개발 중에는 로컬 서버, 배포 시에는 Cloudflare Pages 주소
    allowNavigation: ['golf-score-7xp.pages.dev'],
  },
  plugins: {
    Camera: {
      // iOS 카메라 권한 설명
      presentationStyle: 'fullscreen',
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0a0f0d',
      showSpinner: false,
      launchAutoHide: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0f0d',
    },
  },
};

export default config;
