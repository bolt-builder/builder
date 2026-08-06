import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '~/utils/cn';
import { Input } from './Input';
import { motion, AnimatePresence } from 'framer-motion';

interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Function to call when the clear button is clicked */
  onClear?: () => void;

  /** Whether to show the clear button when there is input */
  showClearButton?: boolean;

  /** Additional class name for the search icon */
  iconClassName?: string;

  /** Additional class name for the container */
  containerClassName?: string;

  /** Whether the search is loading */
  loading?: boolean;

  /** Ref forwarded to the underlying input element */
  ref?: Ref<HTMLInputElement>;
}

/**
 * SearchInput component
 *
 * A search input field with a search icon and optional clear button.
 */
export function SearchInput({
  className,
  onClear,
  showClearButton = true,
  iconClassName,
  containerClassName,
  loading = false,
  ref,
  ...props
}: SearchInputProps) {
  const hasValue = Boolean(props.value);

  return (
    <div className={cn('relative flex items-center w-full', containerClassName)}>
      {/* Search icon or loading spinner */}
      <div className={cn('absolute left-3 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary', iconClassName)}>
        {loading ? (
          <span className="i-ph:spinner-gap animate-spin w-4 h-4" />
        ) : (
          <span className="i-ph:magnifying-glass w-4 h-4" />
        )}
      </div>

      {/* Input field */}
      <Input ref={ref} className={cn('pl-10', hasValue && showClearButton ? 'pr-10' : '', className)} {...props} />

      {/* Clear button */}
      <AnimatePresence>
        {hasValue && showClearButton && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            type="button"
            onClick={onClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary p-1 rounded-full hover:bg-bolt-elements-background-depth-2"
            aria-label="Clear search"
          >
            <span className="i-ph:x w-3.5 h-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
