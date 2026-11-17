import { useState } from 'react';
import { changePassword } from './useSettings';
import { useAuth } from './useAuth';

export const usePasswordManagement = () => {
  const { replaceToken } = useAuth();
  const [form, setForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleChangePassword = async (onSuccess?: () => void) => {
    if (form.newPassword !== form.confirmPassword) {
      setMessage('Passwords do not match');
      return false;
    }

    setSaving(true);
    setMessage(null);
    try {
      const newToken = await changePassword(form.currentPassword, form.newPassword);
      if (newToken) replaceToken(newToken);
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setMessage('Password updated successfully');
      onSuccess?.();
      return true;
    } catch {
      setMessage('Error updating password');
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    form,
    setForm,
    message,
    setMessage,
    saving,
    handleChangePassword,
  };
};
