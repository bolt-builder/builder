import { useState, useMemo, useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { cn } from '~/utils/cn';
import { profileStore, updateProfile } from '~/lib/stores/profile';
import { toast } from 'sonner';
import { debounce } from '~/utils/debounce';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ProfileTab');

export default function ProfileTab() {
  const profile = useStore(profileStore);
  const [isUploading, setIsUploading] = useState(false);

  // Create debounced update functions
  const debouncedUpdate = useMemo(
    () =>
      debounce((field: 'username' | 'bio', value: string) => {
        updateProfile({ [field]: value });
        toast.success(`${field.charAt(0).toUpperCase() + field.slice(1)} updated`);
      }, 1000),
    [],
  );

  // Cancel pending debounce on unmount
  useEffect(() => {
    return () => debouncedUpdate.cancel();
  }, [debouncedUpdate]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      setIsUploading(true);

      // Convert the file to base64
      const reader = new FileReader();

      reader.onloadend = () => {
        const base64String = reader.result as string;
        updateProfile({ avatar: base64String });
        setIsUploading(false);
        toast.success('Profile picture updated');
      };

      reader.onerror = () => {
        logger.error('Error reading file:', reader.error);
        setIsUploading(false);
        toast.error('Failed to update profile picture');
      };
      reader.readAsDataURL(file);
    } catch (error) {
      logger.error('Error uploading avatar:', error);
      setIsUploading(false);
      toast.error('Failed to update profile picture');
    }
  };

  const handleProfileUpdate = (field: 'username' | 'bio', value: string) => {
    // Update the store immediately for UI responsiveness
    updateProfile({ [field]: value });

    // Debounce the toast notification
    debouncedUpdate(field, value);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="space-y-6">
        {/* Personal Information Section */}
        <div>
          {/* Avatar Upload */}
          <div className="flex items-start gap-6 mb-8">
            <div
              className={cn(
                'w-24 h-24 rounded-full overflow-hidden',
                'bg-gray-100 dark:bg-gray-800/50',
                'flex items-center justify-center',
                'ring-1 ring-gray-200 dark:ring-gray-700',
                'relative group',
                'transition-all duration-300 ease-out',
                'hover:ring-bolt-elements-borderColorActive/30 dark:hover:ring-bolt-elements-borderColorActive/30',
                'hover:shadow-lg hover:shadow-[#06B6D4]/10',
              )}
            >
              {profile.avatar ? (
                <img
                  loading="lazy"
                  src={profile.avatar}
                  alt="Profile"
                  className={cn(
                    'w-full h-full object-cover',
                    'transition-all duration-300 ease-out',
                    'group-hover:scale-105 group-hover:brightness-90',
                  )}
                />
              ) : (
                <div className="i-ph:robot-fill w-16 h-16 text-bolt-elements-textTertiary transition-colors group-hover:text-bolt-elements-item-contentAccent/70 transform -translate-y-1" />
              )}

              <label
                className={cn(
                  'absolute inset-0',
                  'flex items-center justify-center',
                  'bg-black/0 group-hover:bg-black/40',
                  'cursor-pointer transition-all duration-300 ease-out',
                  isUploading ? 'cursor-wait' : '',
                )}
              >
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                  disabled={isUploading}
                />
                {isUploading ? (
                  <div className="i-ph:spinner-gap w-6 h-6 text-white animate-spin" />
                ) : (
                  <div className="i-ph:camera-plus w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-all duration-300 ease-out transform group-hover:scale-110" />
                )}
              </label>
            </div>

            <div className="flex-1 pt-1">
              <label className="block text-base font-medium text-gray-900 dark:text-gray-100 mb-1">
                Profile Picture
              </label>
              <p className="text-sm text-bolt-elements-textTertiary">Upload a profile picture or avatar</p>
            </div>
          </div>

          {/* Username Input */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Username</label>
            <div className="relative group">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2">
                <div className="i-ph:user-circle-fill w-5 h-5 text-bolt-elements-textTertiary transition-colors group-focus-within:text-bolt-elements-item-contentAccent" />
              </div>
              <input
                type="text"
                autoComplete="username"
                value={profile.username}
                onChange={(e) => handleProfileUpdate('username', e.target.value)}
                className={cn(
                  'w-full pl-11 pr-4 py-2.5 rounded-xl',
                  'bg-white dark:bg-gray-800/50',
                  'border border-gray-200 dark:border-gray-700/50',
                  'text-bolt-elements-textPrimary',
                  'placeholder-gray-400 dark:placeholder-gray-500',
                  'focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColorActive focus:border-bolt-elements-borderColorActive',
                  'transition-all duration-300 ease-out',
                )}
                placeholder="Enter your username"
              />
            </div>
          </div>

          {/* Bio Input */}
          <div className="mb-8">
            <label htmlFor="profile-bio" className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
              Bio
            </label>
            <div className="relative group">
              <div className="absolute left-3.5 top-3">
                <div className="i-ph:text-aa w-5 h-5 text-bolt-elements-textTertiary transition-colors group-focus-within:text-bolt-elements-item-contentAccent" />
              </div>
              <textarea
                id="profile-bio"
                value={profile.bio}
                onChange={(e) => handleProfileUpdate('bio', e.target.value)}
                className={cn(
                  'w-full pl-11 pr-4 py-2.5 rounded-xl',
                  'bg-white dark:bg-gray-800/50',
                  'border border-gray-200 dark:border-gray-700/50',
                  'text-bolt-elements-textPrimary',
                  'placeholder-gray-400 dark:placeholder-gray-500',
                  'focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColorActive focus:border-bolt-elements-borderColorActive',
                  'transition-all duration-300 ease-out',
                  'resize-none',
                  'h-32',
                )}
                placeholder="Tell us about yourself"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
