variable "project" {
  type    = string
  default = "quizforge"
}

variable "region" {
  type    = string
  default = "us-east-2"
}

variable "github_repo" {
  description = "owner/name of the repository allowed to assume the pipeline roles"
  type        = string
  default     = "jhgcc1/quizforge"
}

variable "create_oidc_provider" {
  description = "The GitHub OIDC provider is account-wide: set false if the account already has one"
  type        = bool
  default     = true
}
