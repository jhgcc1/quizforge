terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Bootstrap itself uses LOCAL state on purpose (it creates the bucket that holds every other state).
  # After the first apply, run `terraform init -migrate-state` with backend.hcl to move it into S3.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.project, ManagedBy = "terraform", Stack = "bootstrap" }
  }
}
