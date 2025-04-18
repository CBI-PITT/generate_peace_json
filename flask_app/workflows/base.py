class BaseWorkflow:
    def __init__(self):
        self.steps = []

    def add_step(self, input, output, operation, extras):
        self.steps.append({
            "input": input,
            "output": output,
            "operation": operation,
            "extras": extras,
        })
