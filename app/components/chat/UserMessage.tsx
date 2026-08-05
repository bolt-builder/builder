import { MODEL_REGEX, PROVIDER_REGEX } from '~/utils/constants';
import { Markdown } from './Markdown';
import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import type {
  TextUIPart,
  ReasoningUIPart,
  ToolInvocationUIPart,
  SourceUIPart,
  FileUIPart,
  StepStartUIPart,
} from '@ai-sdk/ui-utils';

interface UserMessageProps {
  content: string | Array<{ type: string; text?: string; image?: string }>;
  parts:
    (TextUIPart | ReasoningUIPart | ToolInvocationUIPart | SourceUIPart | FileUIPart | StepStartUIPart)[] | undefined;
}

export function UserMessage({ content, parts }: UserMessageProps) {
  const profile = useStore(profileStore);

  // Extract images from parts - look for file parts with image mime types
  const images =
    parts?.filter(
      (part): part is FileUIPart => part.type === 'file' && 'mimeType' in part && part.mimeType.startsWith('image/'),
    ) || [];

  if (Array.isArray(content)) {
    const textItem = content.find((item) => item.type === 'text');
    const textContent = stripMetadata(textItem?.text || '');

    return (
      <div className="overflow-hidden flex flex-col gap-3 items-end w-full min-w-0">
        <div className="flex flex-row items-center gap-2 self-end">
          {profile?.avatar || profile?.username ? (
            <div className="flex items-center gap-2">
              <span className="text-devonz-elements-textSecondary text-sm">
                {profile?.username ? profile.username : 'You'}
              </span>
              <img
                src={profile.avatar}
                alt={profile?.username || 'User'}
                className="w-6 h-6 object-cover rounded-full ring-1 ring-devonz-elements-borderColor"
                loading="eager"
                decoding="sync"
              />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-devonz-elements-textSecondary text-sm">You</span>
              <div className="w-6 h-6 rounded-full bg-accent-500/20 flex items-center justify-center">
                <div className="i-ph:user text-accent-400 text-sm" />
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 max-w-[85%] ml-auto overflow-hidden">
          {textContent && (
            <div className="text-devonz-elements-textPrimary text-sm leading-relaxed min-w-0">
              <Markdown html>{textContent}</Markdown>
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((item, index) => (
                <img
                  key={index}
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt={`Image ${index + 1}`}
                  className="max-w-full h-auto rounded-lg border border-devonz-elements-borderColor"
                  style={{ maxHeight: '256px', objectFit: 'contain' }}
                  width={256}
                  height={256}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const textContent = stripMetadata(content);

  return (
    <div className="flex flex-col items-end gap-3 w-full min-w-0">
      <div className="flex items-center gap-2">
        {profile?.avatar ? (
          <>
            <span className="text-devonz-elements-textSecondary text-sm">{profile?.username || 'You'}</span>
            <img
              src={profile.avatar}
              alt={profile?.username || 'User'}
              className="w-6 h-6 object-cover rounded-full ring-1 ring-devonz-elements-borderColor"
              loading="eager"
              decoding="sync"
            />
          </>
        ) : (
          <>
            <span className="text-devonz-elements-textSecondary text-sm">You</span>
            <div className="w-6 h-6 rounded-full bg-accent-500/20 flex items-center justify-center">
              <div className="i-ph:user text-accent-400 text-sm" />
            </div>
          </>
        )}
      </div>
      <div className="max-w-[85%] ml-auto overflow-hidden">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {images.map((item, index) => (
              <div
                key={index}
                className="relative rounded-lg border border-devonz-elements-borderColor overflow-hidden"
              >
                <img
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt={`Image ${index + 1}`}
                  className="h-16 w-16 object-cover"
                />
              </div>
            ))}
          </div>
        )}
        <div className="text-devonz-elements-textPrimary text-sm leading-relaxed min-w-0">
          <Markdown html>{textContent}</Markdown>
        </div>
      </div>
    </div>
  );
}

function stripMetadata(content: string) {
  const artifactRegex = /<devonzArtifact\s+[^>]*>[\s\S]*?<\/devonzArtifact>/gm;
  return content.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '').replace(artifactRegex, '');
}
