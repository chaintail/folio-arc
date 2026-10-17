# What is intentionally absent

This repository contains the funding bridge, restricted EVM signing policies, and local ChatGPT connector.\
The mobile app, full application server, trading engine, and account-management services are outside it.\
Production integration requires the private Folio-server adapter and application services.

## Local and hosted boundaries

The local connector uses its included core and test accounts. Production connector configuration, deployment credentials, and the application adapter are not included.

The bridge tests exercise the extracted modules. They do not start the full Folio service or establish readiness for an independent production deployment.

## Data excluded from publication

Private keys, runtime databases, deployment host details, raw evidence captures, and application images are not published. [Live transfers](live-runs.md) retains selected public transaction identifiers and separates on-chain delivery from reported application accounting.
