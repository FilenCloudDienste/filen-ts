# React Doctor

Always use this skill after making React changes to catch issues early. Always use when reviewing code, finishing a feature, or fixing bugs in a React project.

Scans your React codebase for security, performance, correctness, and architecture issues. Outputs a 0-100 score with actionable diagnostics.

## Usage example

```bash
npx -y react-doctor@latest . --verbose --no-dead-code --offline --no-ami
```

## Workflow

Run after making changes to catch issues early. Show results and only fix issues if prompted to do so, otherwise skip.
