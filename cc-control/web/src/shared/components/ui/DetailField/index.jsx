export default function DetailField({ title, value }) {
  return value == null || value === '' || (Array.isArray(value) && !value.length) ? null : (
    <section className="field">
      <h3>{title}</h3>
      <pre>
        {typeof value === 'string'
          ? value
          : Array.isArray(value) && value.every(item => typeof item === 'string')
            ? value.map(item => `• ${item}`).join('\n')
            : JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}
