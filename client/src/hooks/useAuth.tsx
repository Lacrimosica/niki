import { useState, useEffect, createContext, useContext } from 'react';
import axios from 'axios';
import { getPermissionsForRole, type Permission } from '../lib/permissions';
import { API_BASE_URL } from '../config';

const setAxiosAuthHeader = (token: string | null) => {
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return;
  }

  delete axios.defaults.headers.common['Authorization'];
};

setAxiosAuthHeader(localStorage.getItem('token'));

export interface AuthUser {
  id?: string;
  email: string;
  orgId: string;
  role: string;
  permissions: Permission[];
}

interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  replaceToken: (token: string) => void;
  isAuthenticated: boolean;
  hasPermission: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem('user');
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return {
        ...parsed,
        permissions: parsed.permissions?.length ? parsed.permissions : getPermissionsForRole(parsed.role),
      };
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
      setAxiosAuthHeader(token);
    } else {
      localStorage.removeItem('token');
      setAxiosAuthHeader(null);
    }
  }, [token]);

  useEffect(() => {
    if (user) {
      localStorage.setItem('user', JSON.stringify(user));
    } else {
      localStorage.removeItem('user');
    }
  }, [user]);

  const clearSession = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setAxiosAuthHeader(null);
    setToken(null);
    setUser(null);
  };

  // Handle unauthorized responses
  useEffect(() => {
    const requestInterceptor = axios.interceptors.request.use((config) => {
      const latestToken = localStorage.getItem('token');
      if (latestToken) {
        config.headers = config.headers ?? {};
        config.headers.Authorization = `Bearer ${latestToken}`;
      }
      return config;
    });

    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          sessionStorage.setItem('session_expired', '1');
          // The server already rejected this token; there is nothing to revoke.
          clearSession();
        }
        return Promise.reject(error);
      }
    );
    return () => {
      axios.interceptors.request.eject(requestInterceptor);
      axios.interceptors.response.eject(interceptor);
    };
  }, []);

  const login = (newToken: string, newUser: AuthUser) => {
    localStorage.setItem('token', newToken);
    setAxiosAuthHeader(newToken);
    setToken(newToken);
    setUser({
      ...newUser,
      permissions: newUser.permissions?.length ? newUser.permissions : getPermissionsForRole(newUser.role),
    });
  };

  const logout = () => {
    const currentToken = localStorage.getItem('token');
    if (currentToken) {
      // Revoke server-side so a copied token stops working. Plain fetch keeps this out
      // of the axios 401 interceptor; keepalive lets it finish if the page navigates.
      fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${currentToken}` },
        keepalive: true,
      }).catch(() => {
        // Best effort: the local session is cleared regardless and the token expires.
      });
    }
    clearSession();
  };

  /** Swap in a re-issued token (e.g. after a password change revoked the old one). */
  const replaceToken = (newToken: string) => {
    localStorage.setItem('token', newToken);
    setAxiosAuthHeader(newToken);
    setToken(newToken);
  };

  const hasPermission = (permission: Permission) => {
    if (!user) return false;
    return user.permissions.includes(permission);
  };

  return (
    <AuthContext.Provider value={{ token, user, login, logout, replaceToken, isAuthenticated: !!token && !!user, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
};

// Hook and provider share the context, so they live in one module.
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
