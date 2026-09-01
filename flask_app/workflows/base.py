class BaseWorkflow:
    def __init__(self):
        self.steps = []
        self.workflow_id = None

    def add_step(self, input, output, operation, extras, step_id=None):
        self.steps.append({
            "input_bindings": input,
            "output_name": output,
            "operation": operation,
            "extras": extras,
            "step_id": step_id,
        })
