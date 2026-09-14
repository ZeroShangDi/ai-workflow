export default function Button({
  className = '',
  variant,
  ...props
}) {
  return (<button className={`${variant === 'primary' ? 'primary ' : ''}${className}`} {...props} />);
}
