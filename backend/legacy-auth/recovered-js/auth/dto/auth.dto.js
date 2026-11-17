var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Transform } from 'class-transformer';
import { IsEmail, IsJWT, IsString, MaxLength, MinLength } from 'class-validator';
const normaliseEmail = ({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }) => typeof value === 'string' ? value.trim() : value;
export class RegisterDto {
    email;
    password;
    fullName;
    workspaceName;
}
__decorate([
    Transform(normaliseEmail),
    IsEmail(),
    MaxLength(254),
    __metadata("design:type", String)
], RegisterDto.prototype, "email", void 0);
__decorate([
    IsString(),
    MinLength(8),
    MaxLength(128),
    __metadata("design:type", String)
], RegisterDto.prototype, "password", void 0);
__decorate([
    Transform(trim),
    IsString(),
    MinLength(1),
    MaxLength(100),
    __metadata("design:type", String)
], RegisterDto.prototype, "fullName", void 0);
__decorate([
    Transform(trim),
    IsString(),
    MinLength(2),
    MaxLength(80),
    __metadata("design:type", String)
], RegisterDto.prototype, "workspaceName", void 0);
export class LoginDto {
    email;
    password;
}
__decorate([
    Transform(normaliseEmail),
    IsEmail(),
    MaxLength(254),
    __metadata("design:type", String)
], LoginDto.prototype, "email", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(128),
    __metadata("design:type", String)
], LoginDto.prototype, "password", void 0);
export class RefreshDto {
    refreshToken;
}
__decorate([
    IsJWT(),
    __metadata("design:type", String)
], RefreshDto.prototype, "refreshToken", void 0);
//# sourceMappingURL=auth.dto.js.map