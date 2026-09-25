import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-ui', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata = {
  title: 'PumpTape · US Gasoline Prices',
  description: 'Trading-style charts of US gasoline and diesel prices by state and metro area, logged daily from AAA.',
};

export const viewport = {
  themeColor: '#0c0f14',
};

// Sets the theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem('pt-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
