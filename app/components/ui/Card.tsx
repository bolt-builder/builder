import { cn } from '~/utils/cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
}

function Card({ className, style, ref, ...props }: CardProps) {
  return (
    <div
      ref={ref}
      className={cn('rounded-lg border text-bolt-elements-textPrimary shadow-sm', className)}
      style={{
        backgroundColor: 'var(--bolt-elements-bg-depth-1)',
        borderColor: 'var(--bolt-elements-borderColor)',
        ...style,
      }}
      {...props}
    />
  );
}

function CardHeader({ className, ref, ...props }: CardProps) {
  return <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />;
}

function CardTitle({
  className,
  style,
  ref,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { ref?: React.Ref<HTMLParagraphElement> }) {
  return (
    <h3
      ref={ref}
      className={cn('text-2xl font-semibold leading-none tracking-tight', className)}
      style={{ color: 'var(--bolt-elements-textPrimary)', ...style }}
      {...props}
    />
  );
}

function CardDescription({
  className,
  style,
  ref,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement> & { ref?: React.Ref<HTMLParagraphElement> }) {
  return (
    <p
      ref={ref}
      className={cn('text-sm', className)}
      style={{ color: 'var(--bolt-elements-textSecondary)', ...style }}
      {...props}
    />
  );
}

function CardContent({ className, ref, ...props }: CardProps) {
  return <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />;
}

function CardFooter({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }) {
  return <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
