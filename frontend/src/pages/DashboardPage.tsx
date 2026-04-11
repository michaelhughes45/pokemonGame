import { useAuth } from '../hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'destructive'> = {
  admin: 'destructive',
  dm: 'default',
  player: 'secondary',
};

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <Button variant="outline" onClick={handleLogout} className="min-h-11">
            Log out
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {user.username}
              <Badge variant={roleBadgeVariant[user.role] ?? 'secondary'}>
                {user.role}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Trainer specialty</span>
              <span>{user.trainerStatChoice ?? 'Not chosen yet'}</span>
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Badges</span>
              <span>{user.badges.length === 0 ? 'None yet' : user.badges.join(', ')}</span>
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Money</span>
              <span>₽{user.money.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
