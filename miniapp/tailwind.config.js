/**
 * Tailwind config — Telegram Mini App
 * iOS HIG + liquid glass. Chỉ dùng MÀU PHẲNG ánh xạ qua CSS variables
 * (đổ từ Telegram themeParams lúc runtime). KHÔNG khai báo bất kỳ
 * util chuyển-màu-nền nào (Req 13.2, 13.3).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  // Toggle chế độ tối theo class `.dark` (đặt trên <html> theo colorScheme Telegram).
  darkMode: 'class',
  theme: {
    extend: {
      // Màu phẳng ánh xạ sang CSS variables (light/dark tự đồng bộ qua biến).
      colors: {
        bg: 'var(--tg-bg)',
        app: 'var(--app-bg)',
        surface: 'var(--surface)',
        'secondary-bg': 'var(--tg-secondary-bg)',
        separator: 'var(--separator)',
        text: 'var(--tg-text)',
        hint: 'var(--tg-hint)',
        accent: 'var(--tg-accent)',
        'accent-text': 'var(--tg-accent-text)',
        'accent-soft': 'var(--accent-soft)',
        'ios-green': '#34c759',
        'ios-red': '#ff3b30',
        'ios-orange': '#ff9500',
      },
      // Bo góc kiểu iOS (continuous-corner cảm giác lớn).
      borderRadius: {
        glass: '20px',
        ios: '14px',
      },
      // Vật liệu kính: độ mờ blur dùng cho backdrop-filter.
      backdropBlur: {
        glass: '20px',
      },
      // Easing chuẩn iOS (cảm giác trượt UINavigationController).
      transitionTimingFunction: {
        ios: 'cubic-bezier(0.32, 0.72, 0, 1)',
        'ios-fade': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transitionDuration: {
        ios: '280ms',
      },
      // Đổ bóng nhẹ kiểu iOS cho lớp kính/thẻ nổi.
      boxShadow: {
        glass: '0 8px 24px rgba(0, 0, 0, 0.08)',
        'glass-dark': '0 8px 24px rgba(0, 0, 0, 0.40)',
        ios: '0 1px 3px rgba(0, 0, 0, 0.10)',
      },
      // Khoảng cách an toàn do Telegram WebApp/thiết bị khai báo (Req 13.7).
      spacing: {
        'safe-top': 'var(--safe-top)',
        'safe-bottom': 'var(--safe-bottom)',
        'safe-left': 'var(--safe-left)',
        'safe-right': 'var(--safe-right)',
      },
      // Thang chữ kiểu iOS.
      fontSize: {
        'ios-hero': ['44px', { lineHeight: '52px', fontWeight: '700', letterSpacing: '-0.02em' }],
        'ios-large-title': ['34px', { lineHeight: '41px', fontWeight: '700' }],
        'ios-title': ['22px', { lineHeight: '28px', fontWeight: '600' }],
        'ios-headline': ['17px', { lineHeight: '22px', fontWeight: '600' }],
        'ios-body': ['17px', { lineHeight: '22px' }],
        'ios-footnote': ['13px', { lineHeight: '18px' }],
        'ios-caption': ['12px', { lineHeight: '16px' }],
      },
      fontFamily: {
        ios: [
          '-apple-system',
          'SF Pro Text',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  // Không dùng plugin nào sinh util chuyển-màu-nền. Chỉ màu phẳng + lớp kính.
  plugins: [],
}
