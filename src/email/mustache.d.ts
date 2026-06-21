declare module "mustache" {
  const Mustache: {
    render(template: string, view: Record<string, unknown>): string;
  };
  export default Mustache;
}
