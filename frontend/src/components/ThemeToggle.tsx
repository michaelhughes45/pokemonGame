import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { useTheme } from '../hooks/useTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="fixed bottom-4 right-4 z-50 min-h-11 min-w-11 rounded-full shadow-sm"
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}
